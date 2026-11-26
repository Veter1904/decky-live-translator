import { install } from './realcanvas'
install()
import { glossaryTranslation } from 'E:/Greenlight/packages/desktop/renderer/lib/translator/uiwords'
import { cleanOcrText } from 'E:/Greenlight/packages/desktop/renderer/lib/translator/engine'
const cases: Array<[string, string]> = [
    ['WHAT 15 IT?', 'WHAT IS IT?'], ['15 CEY DOSH', '15 CEY DOSH'], ['15 MINUTES LEFT', '15 MINUTES LEFT'], ['Jetzt 15 Minuten', 'Jetzt 15 Minuten'], ['GO T0 THE DOOR', 'GO TO THE DOOR'],
    ['Qwy', ''], ['tgk', ''], ['TV', ''], ['Hello world', 'Hello world'], ['I5 THIS RAIN S0 DANGEROUS?', 'IS THIS RAIN SO DANGEROUS?'], ['ARE 15 MINUTES LEFT 5', 'ARE 15 MINUTES LEFT 5'],
]
let bad = 0
for (const [input, want] of cases) { const got = cleanOcrText(input); const ok = got === want; if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', JSON.stringify(input), '->', JSON.stringify(got), ok ? '' : 'wanted ' + JSON.stringify(want)) }
for (const [word, want] of [['Loading', 'Завантаження…'], ['LOADING...', 'Завантаження…'], ['Saving', 'Збереження…'], ['Please wait', 'Зачекайте…'], ['Connecting', 'З’єднання…']] as Array<[string, string]>) {
    const got = glossaryTranslation(word, 'en', 'uk'); const ok = got === want; if (!ok) bad++
    console.log(ok ? 'ok  ' : 'FAIL', JSON.stringify(word), '->', JSON.stringify(got))
}
process.exit(bad ? 1 : 0)
