// Decky Live Translator: Vulkan layer that hands the game's own frames to the translator.
//
// Why: the picture gamescope shows contains Steam's UI (our translation plates included), and a screenshot of "the game only" is
// not always possible. This layer sits inside the game's process: it copies the swapchain image (before it is presented, so before
// gamescope and the Steam layer compose anything) into a buffer now and then and writes it into shared memory.
//
// - passive: nothing happens unless the file $XDG_RUNTIME_DIR/dlt/enable exists (the plugin creates it), and only in games started by
//   Steam (SteamGameId is set), never in gamescope, Steam's own processes or tools;
// - cheap: one copy of the frame every `interval` ms (default 300), done by the GPU; the memcpy to shared memory is made by a thread;
// - safe: any failure turns the capture off for that swapchain, the game's own calls are passed on untouched.
//
// Output: /dev/shm/dlt-<uid>/frame: a 4096-byte header followed by the pixels (rows of w*4 bytes in the VkFormat of the swapchain).
//   u32 magic 'DLTF', u32 version(1), u64 seq (odd while being written), u32 width, u32 height, u32 vkformat, u32 stride,
//   u64 realtime_ns, u32 pid, u32 steam_game_id.
#define _GNU_SOURCE
#include <vulkan/vulkan.h>
#include <vulkan/vk_layer.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <time.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <errno.h>
#include <stdarg.h>

#define EXPORT __attribute__((visibility("default")))
#define MAX_INST 8
#define MAX_DEV 8
#define MAX_SWAP 16
#define MAX_QUEUE 32
#define MAX_IMG 16
#define HEADER_SIZE 4096

static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;

// ------------------------------------------------------------------------------------------------ logging / settings

static char g_dir[512];
static int g_dir_ready = 0;
static int g_active = -1;  // -1 unknown, 0 not a game of Steam (inert), 1 active
static uint32_t g_game_id = 0;
static long g_interval_ms = 300;
static uint64_t g_last_check_ns = 0;
static int g_enabled = 0;

static uint64_t now_ns(clockid_t c) { struct timespec t; clock_gettime(c, &t); return (uint64_t)t.tv_sec * 1000000000ull + (uint64_t)t.tv_nsec; }

static void logf_(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void logf_(const char *fmt, ...)
{
    if (!g_dir_ready) return;
    char path[600];
    snprintf(path, sizeof path, "%s/layer.log", g_dir);
    struct stat st;
    if (stat(path, &st) == 0 && st.st_size > 200000) return;  // never grow without limit
    FILE *f = fopen(path, "a");
    if (!f) return;
    va_list ap;
    va_start(ap, fmt);
    fprintf(f, "[%d] ", (int)getpid());
    vfprintf(f, fmt, ap);
    fputc('\n', f);
    va_end(ap);
    fclose(f);
}

static void init_once(void)
{
    if (g_active != -1) return;
    g_active = 0;
    const char *id = getenv("SteamGameId");
    if (!id || !*id || strcmp(id, "0") == 0) return;      // not a game started by Steam: inert
    if (getenv("DLT_DISABLE")) return;
    // /dev/shm is shared between the host and the container of a game (Steam Linux Runtime); XDG_RUNTIME_DIR is not: the container has its own
    snprintf(g_dir, sizeof g_dir, "/dev/shm/dlt-%u", (unsigned)getuid());
    mkdir(g_dir, 0755);
    g_dir_ready = 1;
    g_game_id = (uint32_t)strtoul(id, NULL, 10);
    g_active = 1;
    char exe[256] = {0};
    ssize_t n = readlink("/proc/self/exe", exe, sizeof exe - 1);
    if (n > 0) exe[n] = 0;
    logf_("layer loaded in %s (SteamGameId %s)", exe, id);
}

// Is the capture wanted now? Looked at twice a second at most. The file holds the interval in milliseconds.
static int enabled_now(void)
{
    uint64_t t = now_ns(CLOCK_MONOTONIC);
    if (t - g_last_check_ns < 500000000ull) return g_enabled;
    g_last_check_ns = t;
    char path[600];
    snprintf(path, sizeof path, "%s/enable", g_dir);
    // the translator keeps touching this file while it wants frames; a file nobody touches for 6 s is left from a crash
    struct stat st;
    if (stat(path, &st) != 0 || time(NULL) - st.st_mtime > 6) { g_enabled = 0; return 0; }
    FILE *f = fopen(path, "r");
    if (!f) { g_enabled = 0; return 0; }
    long ms = 0;
    if (fscanf(f, "%ld", &ms) == 1 && ms >= 50 && ms <= 5000) g_interval_ms = ms;
    fclose(f);
    g_enabled = 1;
    return 1;
}

// ------------------------------------------------------------------------------------------------ dispatch tables

typedef struct {
    VkInstance handle;
    void *key;
    PFN_vkGetInstanceProcAddr gipa;
    PFN_vkDestroyInstance DestroyInstance;
    PFN_vkGetPhysicalDeviceMemoryProperties GetPhysicalDeviceMemoryProperties;
    int used;
} Inst;

typedef struct {
    VkDevice handle;
    void *key;
    VkPhysicalDevice phys;
    Inst *inst;
    PFN_vkGetDeviceProcAddr gdpa;
    PFN_vkSetDeviceLoaderData SetDeviceLoaderData;
    PFN_vkDestroyDevice DestroyDevice;
    PFN_vkCreateSwapchainKHR CreateSwapchainKHR;
    PFN_vkDestroySwapchainKHR DestroySwapchainKHR;
    PFN_vkGetSwapchainImagesKHR GetSwapchainImagesKHR;
    PFN_vkQueuePresentKHR QueuePresentKHR;
    PFN_vkGetDeviceQueue GetDeviceQueue;
    PFN_vkGetDeviceQueue2 GetDeviceQueue2;
    PFN_vkCreateCommandPool CreateCommandPool;
    PFN_vkDestroyCommandPool DestroyCommandPool;
    PFN_vkAllocateCommandBuffers AllocateCommandBuffers;
    PFN_vkResetCommandBuffer ResetCommandBuffer;
    PFN_vkBeginCommandBuffer BeginCommandBuffer;
    PFN_vkEndCommandBuffer EndCommandBuffer;
    PFN_vkCmdPipelineBarrier CmdPipelineBarrier;
    PFN_vkCmdCopyImageToBuffer CmdCopyImageToBuffer;
    PFN_vkQueueSubmit QueueSubmit;
    PFN_vkCreateFence CreateFence;
    PFN_vkDestroyFence DestroyFence;
    PFN_vkWaitForFences WaitForFences;
    PFN_vkResetFences ResetFences;
    PFN_vkCreateSemaphore CreateSemaphore;
    PFN_vkDestroySemaphore DestroySemaphore;
    PFN_vkCreateBuffer CreateBuffer;
    PFN_vkDestroyBuffer DestroyBuffer;
    PFN_vkGetBufferMemoryRequirements GetBufferMemoryRequirements;
    PFN_vkAllocateMemory AllocateMemory;
    PFN_vkFreeMemory FreeMemory;
    PFN_vkBindBufferMemory BindBufferMemory;
    PFN_vkMapMemory MapMemory;
    PFN_vkUnmapMemory UnmapMemory;
    PFN_vkInvalidateMappedMemoryRanges InvalidateMappedMemoryRanges;
    VkPhysicalDeviceMemoryProperties memprops;
    // queues we know the family of
    VkQueue queues[MAX_QUEUE];
    uint32_t queue_family[MAX_QUEUE];
    int nqueues;
    // capture resources (one set per device)
    VkCommandPool pool;
    uint32_t pool_family;
    VkCommandBuffer cmd;
    VkFence fence;
    VkSemaphore sem;
    VkBuffer buf;
    VkDeviceMemory mem;
    void *map;
    VkDeviceSize buf_size;
    int mem_cached;       // memory is HOST_CACHED but not coherent: invalidate before reading
    volatile int pending; // a capture is being copied by the thread
    uint64_t last_capture_ns;
    int failed;           // capture failed on this device: stop trying
    int used;
} Dev;

typedef struct {
    VkSwapchainKHR handle;
    Dev *dev;
    uint32_t w, h;
    VkFormat format;
    uint32_t n;
    VkImage images[MAX_IMG];
    int capturable;
    int used;
} Swap;

static Inst g_inst[MAX_INST];
static Dev g_dev[MAX_DEV];
static Swap g_swap[MAX_SWAP];

static inline void *key_of(const void *h) { return h ? *(void *const *)h : NULL; }

static Inst *inst_by_key(void *k) { for (int i = 0; i < MAX_INST; i++) if (g_inst[i].used && g_inst[i].key == k) return &g_inst[i]; return NULL; }
static Dev *dev_by_key(void *k) { for (int i = 0; i < MAX_DEV; i++) if (g_dev[i].used && g_dev[i].key == k) return &g_dev[i]; return NULL; }
static Swap *swap_by_handle(VkSwapchainKHR s) { for (int i = 0; i < MAX_SWAP; i++) if (g_swap[i].used && g_swap[i].handle == s) return &g_swap[i]; return NULL; }

// ------------------------------------------------------------------------------------------------ shared memory output

typedef struct { int fd; void *map; size_t size; } Shm;
static Shm g_shm = { -1, NULL, 0 };

static int shm_ensure(size_t need)
{
    char path[600];
    snprintf(path, sizeof path, "%s/frame", g_dir);
    // The file may have been removed or replaced (a cleaner, an older helper): the frames would then go into a file that nobody reads. The path must still name the file that is written
    if (g_shm.map && g_shm.fd >= 0) {
        struct stat mine, named;
        if (fstat(g_shm.fd, &mine) == 0 && (stat(path, &named) != 0 || mine.st_ino != named.st_ino || mine.st_dev != named.st_dev)) {
            munmap(g_shm.map, g_shm.size);
            g_shm.map = NULL;
            close(g_shm.fd);
            g_shm.fd = -1;
        }
    }
    if (g_shm.map && g_shm.size >= need) return 1;
    if (g_shm.map) { munmap(g_shm.map, g_shm.size); g_shm.map = NULL; }
    if (g_shm.fd < 0) g_shm.fd = open(path, O_RDWR | O_CREAT, 0644);
    if (g_shm.fd < 0) return 0;
    if (ftruncate(g_shm.fd, (off_t)need) != 0) return 0;
    g_shm.map = mmap(NULL, need, PROT_READ | PROT_WRITE, MAP_SHARED, g_shm.fd, 0);
    if (g_shm.map == MAP_FAILED) { g_shm.map = NULL; return 0; }
    g_shm.size = need;
    return 1;
}

typedef struct {
    uint32_t magic, version;
    uint64_t seq;
    uint32_t width, height, format, stride;
    uint64_t realtime_ns;
    uint32_t pid, game_id;
} ShmHeader;

static void shm_publish(const void *pixels, uint32_t w, uint32_t h, uint32_t format)
{
    size_t bytes = (size_t)w * h * 4;
    if (!shm_ensure(HEADER_SIZE + bytes)) return;
    volatile ShmHeader *hd = (volatile ShmHeader *)g_shm.map;
    uint64_t seq = hd->seq;
    if (seq & 1) seq++;
    hd->seq = seq + 1;                       // odd: being written
    __atomic_thread_fence(__ATOMIC_SEQ_CST);
    memcpy((char *)g_shm.map + HEADER_SIZE, pixels, bytes);
    hd->magic = 0x46544c44; hd->version = 1; hd->width = w; hd->height = h; hd->format = format; hd->stride = w * 4;
    hd->realtime_ns = now_ns(CLOCK_REALTIME); hd->pid = (uint32_t)getpid(); hd->game_id = g_game_id;
    __atomic_thread_fence(__ATOMIC_SEQ_CST);
    hd->seq = seq + 2;                       // even: done
}

// ------------------------------------------------------------------------------------------------ the copying thread

typedef struct { Dev *dev; uint32_t w, h, format; int has_job; } Job;
static Job g_job;
static pthread_t g_thread;
static int g_thread_started = 0;
static pthread_cond_t g_cond = PTHREAD_COND_INITIALIZER;
static pthread_mutex_t g_job_lock = PTHREAD_MUTEX_INITIALIZER;

static void *copy_thread(void *arg)
{
    (void)arg;
    for (;;) {
        pthread_mutex_lock(&g_job_lock);
        while (!g_job.has_job) pthread_cond_wait(&g_cond, &g_job_lock);
        Job job = g_job;
        pthread_mutex_unlock(&g_job_lock);

        Dev *d = job.dev;
        VkResult r = d->WaitForFences(d->handle, 1, &d->fence, VK_TRUE, 2000000000ull);
        if (r == VK_SUCCESS) {
            if (d->mem_cached) {
                VkMappedMemoryRange range = { VK_STRUCTURE_TYPE_MAPPED_MEMORY_RANGE, NULL, d->mem, 0, VK_WHOLE_SIZE };
                d->InvalidateMappedMemoryRanges(d->handle, 1, &range);
            }
            shm_publish(d->map, job.w, job.h, job.format);
        } else {
            logf_("capture fence wait failed (%d)", (int)r);
            d->failed = 1;
        }
        pthread_mutex_lock(&g_job_lock);
        g_job.has_job = 0;
        d->pending = 0;
        pthread_mutex_unlock(&g_job_lock);
    }
    return NULL;
}

// ------------------------------------------------------------------------------------------------ capture

static int format_supported(VkFormat f)
{
    switch (f) {
    case VK_FORMAT_B8G8R8A8_UNORM: case VK_FORMAT_B8G8R8A8_SRGB:
    case VK_FORMAT_R8G8B8A8_UNORM: case VK_FORMAT_R8G8B8A8_SRGB:
    case VK_FORMAT_A2B10G10R10_UNORM_PACK32: case VK_FORMAT_A2R10G10B10_UNORM_PACK32:
        return 1;
    default:
        return 0;
    }
}

static int find_memory_type(Dev *d, uint32_t bits, VkMemoryPropertyFlags want, VkMemoryPropertyFlags avoid)
{
    for (uint32_t i = 0; i < d->memprops.memoryTypeCount; i++)
        if ((bits & (1u << i)) && (d->memprops.memoryTypes[i].propertyFlags & want) == want && !(d->memprops.memoryTypes[i].propertyFlags & avoid))
            return (int)i;
    return -1;
}

static void release_capture(Dev *d)
{
    if (d->buf) { if (d->map) d->UnmapMemory(d->handle, d->mem); d->DestroyBuffer(d->handle, d->buf, NULL); }
    if (d->mem) d->FreeMemory(d->handle, d->mem, NULL);
    d->buf = VK_NULL_HANDLE; d->mem = VK_NULL_HANDLE; d->map = NULL; d->buf_size = 0;
}

static int ensure_capture(Dev *d, uint32_t family, VkDeviceSize size)
{
    if (!d->pool || d->pool_family != family) {
        if (d->pool) { d->DestroyCommandPool(d->handle, d->pool, NULL); d->pool = VK_NULL_HANDLE; d->cmd = VK_NULL_HANDLE; }
        VkCommandPoolCreateInfo pi = { VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO, NULL, VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT, family };
        if (d->CreateCommandPool(d->handle, &pi, NULL, &d->pool) != VK_SUCCESS) return 0;
        d->pool_family = family;
        VkCommandBufferAllocateInfo ai = { VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO, NULL, d->pool, VK_COMMAND_BUFFER_LEVEL_PRIMARY, 1 };
        if (d->AllocateCommandBuffers(d->handle, &ai, &d->cmd) != VK_SUCCESS) return 0;
        if (d->SetDeviceLoaderData && d->SetDeviceLoaderData(d->handle, d->cmd) != VK_SUCCESS) return 0;
    }
    if (!d->fence) {
        VkFenceCreateInfo fi = { VK_STRUCTURE_TYPE_FENCE_CREATE_INFO, NULL, 0 };
        if (d->CreateFence(d->handle, &fi, NULL, &d->fence) != VK_SUCCESS) return 0;
    }
    if (!d->sem) {
        VkSemaphoreCreateInfo si = { VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO, NULL, 0 };
        if (d->CreateSemaphore(d->handle, &si, NULL, &d->sem) != VK_SUCCESS) return 0;
    }
    if (!d->buf || d->buf_size < size) {
        release_capture(d);
        VkBufferCreateInfo bi = { VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO, NULL, 0, size, VK_BUFFER_USAGE_TRANSFER_DST_BIT, VK_SHARING_MODE_EXCLUSIVE, 0, NULL };
        if (d->CreateBuffer(d->handle, &bi, NULL, &d->buf) != VK_SUCCESS) return 0;
        VkMemoryRequirements req;
        d->GetBufferMemoryRequirements(d->handle, d->buf, &req);
        d->mem_cached = 0;
        int type = find_memory_type(d, req.memoryTypeBits, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT | VK_MEMORY_PROPERTY_HOST_CACHED_BIT, 0);
        if (type < 0) {
            type = find_memory_type(d, req.memoryTypeBits, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_CACHED_BIT, 0);
            if (type >= 0) d->mem_cached = 1;
        }
        if (type < 0) type = find_memory_type(d, req.memoryTypeBits, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT, 0);
        if (type < 0) { d->DestroyBuffer(d->handle, d->buf, NULL); d->buf = VK_NULL_HANDLE; return 0; }
        VkMemoryAllocateInfo mi = { VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, NULL, req.size, (uint32_t)type };
        if (d->AllocateMemory(d->handle, &mi, NULL, &d->mem) != VK_SUCCESS) { d->DestroyBuffer(d->handle, d->buf, NULL); d->buf = VK_NULL_HANDLE; return 0; }
        if (d->BindBufferMemory(d->handle, d->buf, d->mem, 0) != VK_SUCCESS) return 0;
        if (d->MapMemory(d->handle, d->mem, 0, VK_WHOLE_SIZE, 0, &d->map) != VK_SUCCESS) return 0;
        d->buf_size = size;
        logf_("capture buffer %llu bytes, memory type %d%s", (unsigned long long)size, type, d->mem_cached ? " (cached, not coherent)" : "");
    }
    return 1;
}

static int queue_family_of(Dev *d, VkQueue q)
{
    for (int i = 0; i < d->nqueues; i++) if (d->queues[i] == q) return (int)d->queue_family[i];
    return -1;
}

// Records and submits the copy of one swapchain image; returns the semaphore the present has to wait for (or NULL when nothing was done)
static VkSemaphore capture_image(Dev *d, VkQueue queue, Swap *sw, uint32_t image_index, const VkPresentInfoKHR *pi)
{
    int family = queue_family_of(d, queue);
    if (family < 0 || image_index >= sw->n) return VK_NULL_HANDLE;
    VkDeviceSize size = (VkDeviceSize)sw->w * sw->h * 4;
    if (!ensure_capture(d, (uint32_t)family, size)) { logf_("capture resources failed"); d->failed = 1; return VK_NULL_HANDLE; }

    d->ResetFences(d->handle, 1, &d->fence);
    d->ResetCommandBuffer(d->cmd, 0);
    VkCommandBufferBeginInfo bi = { VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO, NULL, VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT, NULL };
    if (d->BeginCommandBuffer(d->cmd, &bi) != VK_SUCCESS) return VK_NULL_HANDLE;

    VkImageMemoryBarrier to_src = { VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER, NULL, VK_ACCESS_MEMORY_WRITE_BIT, VK_ACCESS_TRANSFER_READ_BIT,
        VK_IMAGE_LAYOUT_PRESENT_SRC_KHR, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, VK_QUEUE_FAMILY_IGNORED, VK_QUEUE_FAMILY_IGNORED,
        sw->images[image_index], { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 } };
    d->CmdPipelineBarrier(d->cmd, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, NULL, 0, NULL, 1, &to_src);
    VkBufferImageCopy region = { 0, 0, 0, { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 }, { 0, 0, 0 }, { sw->w, sw->h, 1 } };
    d->CmdCopyImageToBuffer(d->cmd, sw->images[image_index], VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, d->buf, 1, &region);
    VkImageMemoryBarrier to_present = to_src;
    to_present.srcAccessMask = VK_ACCESS_TRANSFER_READ_BIT; to_present.dstAccessMask = VK_ACCESS_MEMORY_READ_BIT;
    to_present.oldLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL; to_present.newLayout = VK_IMAGE_LAYOUT_PRESENT_SRC_KHR;
    d->CmdPipelineBarrier(d->cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, 0, 0, NULL, 0, NULL, 1, &to_present);
    if (d->EndCommandBuffer(d->cmd) != VK_SUCCESS) return VK_NULL_HANDLE;

    VkPipelineStageFlags stages[16];
    uint32_t nwait = pi->waitSemaphoreCount > 16 ? 16 : pi->waitSemaphoreCount;
    for (uint32_t i = 0; i < nwait; i++) stages[i] = VK_PIPELINE_STAGE_ALL_COMMANDS_BIT;
    VkSubmitInfo si = { VK_STRUCTURE_TYPE_SUBMIT_INFO, NULL, nwait, pi->pWaitSemaphores, stages, 1, &d->cmd, 1, &d->sem };
    if (d->QueueSubmit(queue, 1, &si, d->fence) != VK_SUCCESS) { logf_("submit failed"); d->failed = 1; return VK_NULL_HANDLE; }

    pthread_mutex_lock(&g_job_lock);
    if (!g_thread_started) { g_thread_started = 1; pthread_create(&g_thread, NULL, copy_thread, NULL); }
    g_job.dev = d; g_job.w = sw->w; g_job.h = sw->h; g_job.format = (uint32_t)sw->format; g_job.has_job = 1;
    d->pending = 1;
    pthread_cond_signal(&g_cond);
    pthread_mutex_unlock(&g_job_lock);
    return d->sem;
}

// ------------------------------------------------------------------------------------------------ intercepted functions

static VKAPI_ATTR VkResult VKAPI_CALL dlt_QueuePresentKHR(VkQueue queue, const VkPresentInfoKHR *pi)
{
    Dev *d = dev_by_key(key_of(queue));
    if (!d) return VK_ERROR_DEVICE_LOST;
    if (g_active == 1 && !d->failed && !d->pending && pi->waitSemaphoreCount <= 16 && enabled_now()) {
        uint64_t t = now_ns(CLOCK_MONOTONIC);
        if (t - d->last_capture_ns >= (uint64_t)g_interval_ms * 1000000ull) {
            pthread_mutex_lock(&g_lock);
            // the biggest swapchain of this device is the game's window
            Swap *best = NULL; uint32_t best_index = 0;
            for (uint32_t i = 0; i < pi->swapchainCount; i++) {
                Swap *s = swap_by_handle(pi->pSwapchains[i]);
                if (s && s->dev == d && s->capturable && (!best || (uint64_t)s->w * s->h > (uint64_t)best->w * best->h)) { best = s; best_index = pi->pImageIndices[i]; }
            }
            Swap copy; int have = 0;
            if (best) { copy = *best; have = 1; }
            pthread_mutex_unlock(&g_lock);
            if (have && copy.w >= 320 && copy.h >= 200) {
                VkSemaphore sem = capture_image(d, queue, &copy, best_index, pi);
                d->last_capture_ns = t;
                if (sem) {
                    VkPresentInfoKHR modified = *pi;
                    modified.waitSemaphoreCount = 1;
                    modified.pWaitSemaphores = &sem;
                    return d->QueuePresentKHR(queue, &modified);
                }
            }
        }
    }
    return d->QueuePresentKHR(queue, pi);
}

static VKAPI_ATTR VkResult VKAPI_CALL dlt_CreateSwapchainKHR(VkDevice device, const VkSwapchainCreateInfoKHR *ci, const VkAllocationCallbacks *ac, VkSwapchainKHR *out)
{
    Dev *d = dev_by_key(key_of(device));
    if (!d) return VK_ERROR_INITIALIZATION_FAILED;
    int want = g_active == 1 && format_supported(ci->imageFormat);
    VkResult r;
    int added = 0;
    if (want) {
        VkSwapchainCreateInfoKHR copy = *ci;
        copy.imageUsage |= VK_IMAGE_USAGE_TRANSFER_SRC_BIT;
        r = d->CreateSwapchainKHR(device, &copy, ac, out);
        if (r == VK_SUCCESS) added = 1;
        else r = d->CreateSwapchainKHR(device, ci, ac, out);   // this surface cannot be read: create it as the game asked
    } else {
        r = d->CreateSwapchainKHR(device, ci, ac, out);
    }
    if (r != VK_SUCCESS) return r;

    pthread_mutex_lock(&g_lock);
    Swap *s = NULL;
    for (int i = 0; i < MAX_SWAP; i++) if (!g_swap[i].used) { s = &g_swap[i]; break; }
    if (s) {
        memset(s, 0, sizeof *s);
        s->used = 1; s->handle = *out; s->dev = d; s->w = ci->imageExtent.width; s->h = ci->imageExtent.height; s->format = ci->imageFormat;
        uint32_t n = 0;
        if (d->GetSwapchainImagesKHR(device, *out, &n, NULL) == VK_SUCCESS && n > 0 && n <= MAX_IMG) {
            s->n = n;
            if (d->GetSwapchainImagesKHR(device, *out, &n, s->images) == VK_SUCCESS) s->capturable = added;
        }
        logf_("swapchain %ux%u format %d images %u capturable %d", s->w, s->h, (int)s->format, s->n, s->capturable);
    }
    pthread_mutex_unlock(&g_lock);
    return r;
}

static VKAPI_ATTR void VKAPI_CALL dlt_DestroySwapchainKHR(VkDevice device, VkSwapchainKHR swapchain, const VkAllocationCallbacks *ac)
{
    Dev *d = dev_by_key(key_of(device));
    pthread_mutex_lock(&g_lock);
    Swap *s = swap_by_handle(swapchain);
    if (s) s->used = 0;
    pthread_mutex_unlock(&g_lock);
    if (d) {
        for (int i = 0; i < 200 && d->pending; i++) usleep(10000);   // a copy of its image may be running
        d->DestroySwapchainKHR(device, swapchain, ac);
    }
}

static VKAPI_ATTR void VKAPI_CALL dlt_GetDeviceQueue(VkDevice device, uint32_t family, uint32_t index, VkQueue *q)
{
    Dev *d = dev_by_key(key_of(device));
    if (!d) return;
    d->GetDeviceQueue(device, family, index, q);
    pthread_mutex_lock(&g_lock);
    if (*q && d->nqueues < MAX_QUEUE) { d->queues[d->nqueues] = *q; d->queue_family[d->nqueues] = family; d->nqueues++; }
    pthread_mutex_unlock(&g_lock);
}

static VKAPI_ATTR void VKAPI_CALL dlt_GetDeviceQueue2(VkDevice device, const VkDeviceQueueInfo2 *info, VkQueue *q)
{
    Dev *d = dev_by_key(key_of(device));
    if (!d || !d->GetDeviceQueue2) return;
    d->GetDeviceQueue2(device, info, q);
    pthread_mutex_lock(&g_lock);
    if (*q && d->nqueues < MAX_QUEUE) { d->queues[d->nqueues] = *q; d->queue_family[d->nqueues] = info->queueFamilyIndex; d->nqueues++; }
    pthread_mutex_unlock(&g_lock);
}

static VKAPI_ATTR void VKAPI_CALL dlt_DestroyDevice(VkDevice device, const VkAllocationCallbacks *ac)
{
    Dev *d = dev_by_key(key_of(device));
    if (!d) return;
    for (int i = 0; i < 200 && d->pending; i++) usleep(10000);
    PFN_vkDestroyDevice destroy = d->DestroyDevice;
    if (d->fence) d->DestroyFence(device, d->fence, NULL);
    if (d->sem) d->DestroySemaphore(device, d->sem, NULL);
    release_capture(d);
    if (d->pool) d->DestroyCommandPool(device, d->pool, NULL);
    pthread_mutex_lock(&g_lock);
    for (int i = 0; i < MAX_SWAP; i++) if (g_swap[i].used && g_swap[i].dev == d) g_swap[i].used = 0;
    d->used = 0;
    pthread_mutex_unlock(&g_lock);
    destroy(device, ac);
}

#define GETD(name) d->name = (PFN_vk##name)next_gdpa(*out, "vk" #name)

static VKAPI_ATTR VkResult VKAPI_CALL dlt_CreateDevice(VkPhysicalDevice phys, const VkDeviceCreateInfo *ci, const VkAllocationCallbacks *ac, VkDevice *out)
{
    Inst *in = inst_by_key(key_of(phys));
    if (!in) return VK_ERROR_INITIALIZATION_FAILED;
    VkLayerDeviceCreateInfo *li = (VkLayerDeviceCreateInfo *)ci->pNext;
    while (li && !(li->sType == VK_STRUCTURE_TYPE_LOADER_DEVICE_CREATE_INFO && li->function == VK_LAYER_LINK_INFO)) li = (VkLayerDeviceCreateInfo *)li->pNext;
    if (!li) return VK_ERROR_INITIALIZATION_FAILED;
    PFN_vkGetInstanceProcAddr next_gipa = li->u.pLayerInfo->pfnNextGetInstanceProcAddr;
    PFN_vkGetDeviceProcAddr next_gdpa = li->u.pLayerInfo->pfnNextGetDeviceProcAddr;
    li->u.pLayerInfo = li->u.pLayerInfo->pNext;

    PFN_vkSetDeviceLoaderData set_data = NULL;
    for (VkLayerDeviceCreateInfo *c = (VkLayerDeviceCreateInfo *)ci->pNext; c; c = (VkLayerDeviceCreateInfo *)c->pNext)
        if (c->sType == VK_STRUCTURE_TYPE_LOADER_DEVICE_CREATE_INFO && c->function == VK_LOADER_DATA_CALLBACK) { set_data = c->u.pfnSetDeviceLoaderData; break; }

    PFN_vkCreateDevice create = (PFN_vkCreateDevice)next_gipa(in->handle, "vkCreateDevice");
    VkResult r = create(phys, ci, ac, out);
    if (r != VK_SUCCESS) return r;

    pthread_mutex_lock(&g_lock);
    Dev *d = NULL;
    for (int i = 0; i < MAX_DEV; i++) if (!g_dev[i].used) { d = &g_dev[i]; break; }
    if (!d) { pthread_mutex_unlock(&g_lock); return r; }   // too many devices: the game works without us
    memset(d, 0, sizeof *d);
    d->used = 1; d->handle = *out; d->key = key_of(*out); d->phys = phys; d->inst = in; d->gdpa = next_gdpa; d->SetDeviceLoaderData = set_data;
    GETD(DestroyDevice); GETD(CreateSwapchainKHR); GETD(DestroySwapchainKHR); GETD(GetSwapchainImagesKHR); GETD(QueuePresentKHR);
    GETD(GetDeviceQueue); GETD(GetDeviceQueue2); GETD(CreateCommandPool); GETD(DestroyCommandPool); GETD(AllocateCommandBuffers);
    GETD(ResetCommandBuffer); GETD(BeginCommandBuffer); GETD(EndCommandBuffer); GETD(CmdPipelineBarrier); GETD(CmdCopyImageToBuffer);
    GETD(QueueSubmit); GETD(CreateFence); GETD(DestroyFence); GETD(WaitForFences); GETD(ResetFences); GETD(CreateSemaphore);
    GETD(DestroySemaphore); GETD(CreateBuffer); GETD(DestroyBuffer); GETD(GetBufferMemoryRequirements); GETD(AllocateMemory);
    GETD(FreeMemory); GETD(BindBufferMemory); GETD(MapMemory); GETD(UnmapMemory); GETD(InvalidateMappedMemoryRanges);
    in->GetPhysicalDeviceMemoryProperties(phys, &d->memprops);
    // without these the capture cannot work: the device is passed on untouched
    if (!d->CreateSwapchainKHR || !d->QueuePresentKHR || !d->QueueSubmit || !d->CmdCopyImageToBuffer || !d->WaitForFences) d->failed = 1;
    pthread_mutex_unlock(&g_lock);
    return r;
}

static VKAPI_ATTR VkResult VKAPI_CALL dlt_CreateInstance(const VkInstanceCreateInfo *ci, const VkAllocationCallbacks *ac, VkInstance *out)
{
    init_once();
    VkLayerInstanceCreateInfo *li = (VkLayerInstanceCreateInfo *)ci->pNext;
    while (li && !(li->sType == VK_STRUCTURE_TYPE_LOADER_INSTANCE_CREATE_INFO && li->function == VK_LAYER_LINK_INFO)) li = (VkLayerInstanceCreateInfo *)li->pNext;
    if (!li) return VK_ERROR_INITIALIZATION_FAILED;
    PFN_vkGetInstanceProcAddr next_gipa = li->u.pLayerInfo->pfnNextGetInstanceProcAddr;
    li->u.pLayerInfo = li->u.pLayerInfo->pNext;
    PFN_vkCreateInstance create = (PFN_vkCreateInstance)next_gipa(NULL, "vkCreateInstance");
    VkResult r = create(ci, ac, out);
    if (r != VK_SUCCESS) return r;
    pthread_mutex_lock(&g_lock);
    for (int i = 0; i < MAX_INST; i++) if (!g_inst[i].used) {
        g_inst[i].used = 1; g_inst[i].handle = *out; g_inst[i].key = key_of(*out); g_inst[i].gipa = next_gipa;
        g_inst[i].DestroyInstance = (PFN_vkDestroyInstance)next_gipa(*out, "vkDestroyInstance");
        g_inst[i].GetPhysicalDeviceMemoryProperties = (PFN_vkGetPhysicalDeviceMemoryProperties)next_gipa(*out, "vkGetPhysicalDeviceMemoryProperties");
        break;
    }
    pthread_mutex_unlock(&g_lock);
    return r;
}

static VKAPI_ATTR void VKAPI_CALL dlt_DestroyInstance(VkInstance instance, const VkAllocationCallbacks *ac)
{
    Inst *in = inst_by_key(key_of(instance));
    if (!in) return;
    PFN_vkDestroyInstance destroy = in->DestroyInstance;
    pthread_mutex_lock(&g_lock);
    in->used = 0;
    pthread_mutex_unlock(&g_lock);
    destroy(instance, ac);
}

// ------------------------------------------------------------------------------------------------ the layer interface

static VKAPI_ATTR PFN_vkVoidFunction VKAPI_CALL dlt_GetDeviceProcAddr(VkDevice device, const char *name)
{
    if (!strcmp(name, "vkGetDeviceProcAddr")) return (PFN_vkVoidFunction)dlt_GetDeviceProcAddr;
    if (!strcmp(name, "vkCreateSwapchainKHR")) return (PFN_vkVoidFunction)dlt_CreateSwapchainKHR;
    if (!strcmp(name, "vkDestroySwapchainKHR")) return (PFN_vkVoidFunction)dlt_DestroySwapchainKHR;
    if (!strcmp(name, "vkQueuePresentKHR")) return (PFN_vkVoidFunction)dlt_QueuePresentKHR;
    if (!strcmp(name, "vkGetDeviceQueue")) return (PFN_vkVoidFunction)dlt_GetDeviceQueue;
    if (!strcmp(name, "vkGetDeviceQueue2")) return (PFN_vkVoidFunction)dlt_GetDeviceQueue2;
    if (!strcmp(name, "vkDestroyDevice")) return (PFN_vkVoidFunction)dlt_DestroyDevice;
    Dev *d = dev_by_key(key_of(device));
    if (!d || !d->gdpa) return NULL;
    return d->gdpa(device, name);
}

static VKAPI_ATTR PFN_vkVoidFunction VKAPI_CALL dlt_GetInstanceProcAddr(VkInstance instance, const char *name)
{
    if (!strcmp(name, "vkGetInstanceProcAddr")) return (PFN_vkVoidFunction)dlt_GetInstanceProcAddr;
    if (!strcmp(name, "vkCreateInstance")) return (PFN_vkVoidFunction)dlt_CreateInstance;
    if (!strcmp(name, "vkDestroyInstance")) return (PFN_vkVoidFunction)dlt_DestroyInstance;
    if (!strcmp(name, "vkCreateDevice")) return (PFN_vkVoidFunction)dlt_CreateDevice;
    if (!strcmp(name, "vkGetDeviceProcAddr")) return (PFN_vkVoidFunction)dlt_GetDeviceProcAddr;
    Inst *in = inst_by_key(key_of(instance));
    if (!in || !in->gipa) return NULL;
    return in->gipa(instance, name);
}

EXPORT VKAPI_ATTR VkResult VKAPI_CALL vkNegotiateLoaderLayerInterfaceVersion(VkNegotiateLayerInterface *v)
{
    if (v->loaderLayerInterfaceVersion >= 2) {
        v->loaderLayerInterfaceVersion = 2;
        v->pfnGetInstanceProcAddr = dlt_GetInstanceProcAddr;
        v->pfnGetDeviceProcAddr = dlt_GetDeviceProcAddr;
        v->pfnGetPhysicalDeviceProcAddr = NULL;
    }
    return VK_SUCCESS;
}

EXPORT VKAPI_ATTR PFN_vkVoidFunction VKAPI_CALL vkGetInstanceProcAddr(VkInstance instance, const char *name) { return dlt_GetInstanceProcAddr(instance, name); }
EXPORT VKAPI_ATTR PFN_vkVoidFunction VKAPI_CALL vkGetDeviceProcAddr(VkDevice device, const char *name) { return dlt_GetDeviceProcAddr(device, name); }
