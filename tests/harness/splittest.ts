import { setWordList, splitJoinedWords } from 'E:/Greenlight/packages/desktop/renderer/lib/translator/ppocr'
const fs = require('fs')
setWordList(fs.readFileSync('E:/decky-live-translator/assets/ocr/words-en.txt', 'utf8'))
const cases: Array<[string, string]> = [
    ["This will testyour'Iron'skill.Iron is the skill", "This will test your 'Iron' skill. Iron is the skill"],
    ['Gobackout onto theOzymandias\'hull,climbpast the', ''],
    ["don't you're it's", "don't you're it's"],
    ['TAKEIT now', 'TAKE IT now'],
    ['75% chance of success.', '75% chance of success.'],
    ['Mr.Smith went', 'Mr. Smith went'],
]
for(const [input, expected] of cases){
    const out = splitJoinedWords(input)
    console.log((expected === '' || out === expected ? 'ok  ' : 'FAIL'), JSON.stringify(input), '->', JSON.stringify(out))
}
import { fixNearWords } from 'E:/Greenlight/packages/desktop/renderer/lib/translator/ppocr'
const near: Array<[string, string]> = [
    ['Dycle PDA', 'Cycle PDA'], ['Back to Ist', 'back to list'.replace('back','Back')], ['Ist', 'list'], ['Ion', 'Ion'], ['PDA', 'PDA'], ['Ian said', 'Ian said'], ['Back to Iist', 'Back to list'], ['Seroll', 'Scroll'], ['Cycle Interface', 'Cycle Interface'],
    ['Ramsey Center', 'Ramsey Center'], ['Ozymandias hull', 'Ozymandias hull'], ['Trainer: Now try picking up the Audio Log', 'Trainer: Now try picking up the Audio Log'],
    ['Equip', 'Equip'], ['Inventory', 'Inventory'], ['Obtoined a Life Capsule', ''], ['Unfortunately, your way is blocked.', 'Unfortunately, your way is blocked.'],
]
for(const [input, expected] of near){
    const out = fixNearWords(input)
    console.log((expected === '' || out === expected ? 'ok  ' : 'FAIL'), JSON.stringify(input), '->', JSON.stringify(out))
}
