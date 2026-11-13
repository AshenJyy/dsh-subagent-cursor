// Transpile and package assets only. Does not load the plugin or execute tests.
import { stripTypeScriptTypes } from 'node:module'
import { readdir, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, basename } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const source = join(root, 'src')
const output = join(root, 'lib')
await mkdir(join(output, 'types'), { recursive: true })
const files = (await readdir(source)).filter(name => name.endsWith('.ts')).sort()
for (const file of files) {
  const input = await readFile(join(source, file), 'utf8')
  const code = input.replace(/(from\s+['"]\.\.?\/[^'"]+)\.ts(['"])/g, '$1.js$2')
  const javascript = stripTypeScriptTypes(code, {
    mode: 'strip',
  })
  await writeFile(join(output, `${basename(file, '.ts')}.js`), javascript, 'utf8')
}
await copyFile(join(root, 'types', 'index.d.ts'), join(output, 'types', 'index.d.ts'))
console.log(`Built ${files.length} ESM modules; no tests executed.`)
