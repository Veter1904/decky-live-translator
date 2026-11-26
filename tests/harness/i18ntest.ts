// The interface languages: every language has every string, with the same {places} as English; choosing the language by the one of Steam.
import { STRINGS, UI_LANGUAGES, SOURCE_LANGUAGES, TARGET_LANGUAGES, interfaceLanguageFor, languageName, languageOptions, setUiLanguage, t } from '../../src/i18n'
let bad = 0
const check = (label: string, ok: boolean, detail = '') => { console.log((ok ? 'ok   ' : 'FAIL ') + label + (ok || detail === '' ? '' : ': ' + detail)); if (!ok) bad++ }
const places = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort().join(',')
const english = STRINGS.en
const keys = Object.keys(english) as Array<keyof typeof english>

check('13 languages', UI_LANGUAGES.length === 13)
for (const { code } of UI_LANGUAGES) {
    const strings = STRINGS[code]
    const missing = keys.filter(key => typeof strings[key] !== 'string' || strings[key].trim() === '')
    const extra = Object.keys(strings).filter(key => !(key in english))
    const wrongPlaces = keys.filter(key => strings[key] !== undefined && places(strings[key]) !== places(english[key]))
    check(`${code}: all ${keys.length} strings`, missing.length === 0 && extra.length === 0, `missing ${missing.join(' ')} extra ${extra.join(' ')}`)
    check(`${code}: the same {places} as English`, wrongPlaces.length === 0, wrongPlaces.join(' '))
    if (code !== 'en') {
        const same = keys.filter(key => strings[key] === english[key] && !/^(translator\.online|unit\.|auto\.info|info\.stats)/.test(key) && !(code === 'pt' && key === 'translator.local') && english[key].length > 12)
        check(`${code}: really translated (${same.length} strings equal to English)`, same.length === 0, same.slice(0, 4).join(' '))
    }
}

// the language of Steam
const cases: Array<[string, string | null]> = [['ru', 'ru'], ['uk', 'uk'], ['pt-BR', 'pt'], ['brazilian', 'pt'], ['schinese', 'zh'], ['tchinese', 'zh'], ['koreana', 'ko'], ['latam', 'es'], ['japanese', 'ja'], ['en-US', 'en'], ['english', 'en'], ['sv', null], ['', null]]
for (const [locale, expected] of cases) check(`Steam language "${locale}" -> ${expected}`, interfaceLanguageFor(locale) === expected, String(interfaceLanguageFor(locale)))

// choosing and using
check('a chosen language is used', setUiLanguage('de') === 'de' && t('toggle.label') === 'Spiel übersetzen')
check('{places} are filled', t('status.found', { found: 3, shown: 2 }) === 'Textblöcke gefunden: 3, angezeigt: 2')
check('an unknown place stays', t('records.desc', { count: 1 }).includes('{size}'))
check('"auto" gives a language of the interface (the one of Steam, else of the browser, else English)', UI_LANGUAGES.some(l => l.code === setUiLanguage('auto')))
setUiLanguage('uk')
check('names of languages come in the language of the interface', languageName('de') === 'Німецька', languageName('de'))
setUiLanguage('en')
check('names in English', languageName('uk') === 'Ukrainian', languageName('uk'))
const options = languageOptions(TARGET_LANGUAGES)
check('options are sorted by name', options.every((o, i) => i === 0 || options[i - 1].label.localeCompare(o.label, 'en') <= 0))
check('every target language has a name', options.every(o => o.label !== o.data), options.filter(o => o.label === o.data).map(o => o.data).join(' '))
check('the languages of the games are known to the picker', SOURCE_LANGUAGES.every(code => TARGET_LANGUAGES.includes(code)))
process.exit(bad)
