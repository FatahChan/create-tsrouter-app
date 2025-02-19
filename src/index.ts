#!/usr/bin/env node

import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command, InvalidArgumentError } from 'commander'
import { intro, log, multiselect, outro, spinner } from '@clack/prompts'
import { execa } from 'execa'
import { render } from 'ejs'
import { format } from 'prettier'
import chalk from 'chalk'

import {
  SUPPORTED_PACKAGE_MANAGERS,
  getPackageManager,
} from './utils/getPackageManager.js'

import type { PackageManager } from './utils/getPackageManager.js'

const program = new Command()

const CODE_ROUTER = 'code-router'
const FILE_ROUTER = 'file-router'

type AddOn = {
  id: string
  name: string
  description: string
  link: string
  main?: Array<{
    imports: Array<string>
    initialize: Array<string>
    providers: Array<{
      open: string
      close: string
    }>
  }>
  layout?: {
    imports: Array<string>
    jsx: string
  }
  routes: Array<{
    url: string
    name: string
  }>
  userUi?: {
    import: string
    jsx: string
  }
  directory: string
  packageAdditions: {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    scripts?: Record<string, string>
  }
  command?: {
    command: string
    args?: Array<string>
  }
  readme?: string
  phase: 'setup' | 'add-on'
  shadcnComponents?: Array<string>
  warning?: string
}

interface Options {
  typescript: boolean
  tailwind: boolean
  packageManager: PackageManager
  mode: typeof CODE_ROUTER | typeof FILE_ROUTER
  addOns: boolean
  chosenAddOns: Array<AddOn>
}

function isDirectory(path: string): boolean {
  return statSync(path).isDirectory()
}

async function getAllAddOns(): Promise<Array<AddOn>> {
  const addOnsBase = fileURLToPath(
    new URL('../templates/add-ons', import.meta.url),
  )

  const addOns: Array<AddOn> = []

  for (const dir of await readdirSync(addOnsBase).filter((file) =>
    isDirectory(resolve(addOnsBase, file)),
  )) {
    const filePath = resolve(addOnsBase, dir, 'info.json')
    const fileContent = await readFile(filePath, 'utf-8')

    let packageAdditions: Record<string, string> = {}
    if (existsSync(resolve(addOnsBase, dir, 'package.json'))) {
      packageAdditions = JSON.parse(
        await readFile(resolve(addOnsBase, dir, 'package.json'), 'utf-8'),
      )
    }

    let readme: string | undefined
    if (existsSync(resolve(addOnsBase, dir, 'README.md'))) {
      readme = await readFile(resolve(addOnsBase, dir, 'README.md'), 'utf-8')
    }

    addOns.push({
      id: dir,
      ...JSON.parse(fileContent),
      directory: resolve(addOnsBase, dir),
      packageAdditions,
      readme,
    })
  }
  return addOns
}

async function pickAddOns(addOns: Array<AddOn>): Promise<Array<AddOn>> {
  const additionalTools = await multiselect({
    message: 'Select add-ons:',
    options: addOns.map((addOn) => ({
      value: addOn.id,
      label: addOn.name,
      hint: addOn.description,
    })),
    required: false,
  })
  return addOns.filter((addOn) =>
    (additionalTools as Array<string>).includes(addOn.id),
  )
}

function sortObject(obj: Record<string, string>): Record<string, string> {
  return Object.keys(obj)
    .sort()
    .reduce<Record<string, string>>((acc, key) => {
      acc[key] = obj[key]
      return acc
    }, {})
}

function createCopyFiles(targetDir: string) {
  return async function copyFiles(templateDir: string, files: Array<string>) {
    for (const file of files) {
      const targetFileName = file.replace('.tw', '')
      await copyFile(
        resolve(templateDir, file),
        resolve(targetDir, targetFileName),
      )
    }
  }
}

function createTemplateFile(
  projectName: string,
  options: Required<Options>,
  targetDir: string,
) {
  return async function templateFile(
    templateDir: string,
    file: string,
    targetFileName?: string,
  ) {
    const templateValues = {
      packageManager: options.packageManager,
      projectName: projectName,
      typescript: options.typescript,
      tailwind: options.tailwind,
      js: options.typescript ? 'ts' : 'js',
      jsx: options.typescript ? 'tsx' : 'jsx',
      fileRouter: options.mode === FILE_ROUTER,
      codeRouter: options.mode === CODE_ROUTER,
      addOnEnabled: options.chosenAddOns.reduce<Record<string, boolean>>(
        (acc, addOn) => {
          acc[addOn.id] = true
          return acc
        },
        {},
      ),
      addOns: options.chosenAddOns,
    }

    const template = await readFile(resolve(templateDir, file), 'utf-8')
    let content = render(template, templateValues)
    const target = targetFileName ?? file.replace('.ejs', '')

    if (target.endsWith('.ts') || target.endsWith('.tsx')) {
      content = await format(content, {
        semi: false,
        singleQuote: true,
        trailingComma: 'all',
        parser: 'typescript',
      })
    }

    await mkdir(dirname(resolve(targetDir, target)), {
      recursive: true,
    })

    await writeFile(resolve(targetDir, target), content)
  }
}

async function createPackageJSON(
  projectName: string,
  options: Required<Options>,
  templateDir: string,
  routerDir: string,
  targetDir: string,
  addOns: Array<{
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    scripts?: Record<string, string>
  }>,
) {
  let packageJSON = JSON.parse(
    await readFile(resolve(templateDir, 'package.json'), 'utf8'),
  )
  packageJSON.name = projectName
  if (options.typescript) {
    const tsPackageJSON = JSON.parse(
      await readFile(resolve(templateDir, 'package.ts.json'), 'utf8'),
    )
    packageJSON = {
      ...packageJSON,
      devDependencies: {
        ...packageJSON.devDependencies,
        ...tsPackageJSON.devDependencies,
      },
    }
  }
  if (options.tailwind) {
    const twPackageJSON = JSON.parse(
      await readFile(resolve(templateDir, 'package.tw.json'), 'utf8'),
    )
    packageJSON = {
      ...packageJSON,
      dependencies: {
        ...packageJSON.dependencies,
        ...twPackageJSON.dependencies,
      },
    }
  }
  if (options.mode === FILE_ROUTER) {
    const frPackageJSON = JSON.parse(
      await readFile(resolve(routerDir, 'package.fr.json'), 'utf8'),
    )
    packageJSON = {
      ...packageJSON,
      dependencies: {
        ...packageJSON.dependencies,
        ...frPackageJSON.dependencies,
      },
    }
  }

  for (const addOn of addOns) {
    packageJSON = {
      ...packageJSON,
      dependencies: {
        ...packageJSON.dependencies,
        ...addOn.dependencies,
      },
      devDependencies: {
        ...packageJSON.devDependencies,
        ...addOn.devDependencies,
      },
      scripts: {
        ...packageJSON.scripts,
        ...addOn.scripts,
      },
    }
  }

  packageJSON.dependencies = sortObject(
    packageJSON.dependencies as Record<string, string>,
  )
  packageJSON.devDependencies = sortObject(
    packageJSON.devDependencies as Record<string, string>,
  )

  await writeFile(
    resolve(targetDir, 'package.json'),
    JSON.stringify(packageJSON, null, 2),
  )
}

async function copyFilesRecursively(
  source: string,
  target: string,
  copyFile: (source: string, target: string) => Promise<void>,
  templateFile: (file: string, targetFileName?: string) => Promise<void>,
) {
  const sourceStat = statSync(source)
  if (sourceStat.isDirectory()) {
    const files = readdirSync(source)
    for (const file of files) {
      const sourceChild = resolve(source, file)
      const targetChild = resolve(target, file)
      await copyFilesRecursively(
        sourceChild,
        targetChild,
        copyFile,
        templateFile,
      )
    }
  } else {
    if (source.endsWith('.ejs')) {
      const targetPath = target.replace('.ejs', '')
      await mkdir(dirname(targetPath), {
        recursive: true,
      })
      await templateFile(source, targetPath)
    } else {
      await mkdir(dirname(target), {
        recursive: true,
      })
      if (source.endsWith('.append')) {
        await appendFile(
          target.replace('.append', ''),
          (await readFile(source)).toString(),
        )
      } else {
        await copyFile(source, target)
      }
    }
  }
}

async function createApp(projectName: string, options: Required<Options>) {
  const templateDirBase = fileURLToPath(
    new URL('../templates/base', import.meta.url),
  )
  const templateDirRouter = fileURLToPath(
    new URL(`../templates/${options.mode}`, import.meta.url),
  )
  const targetDir = resolve(process.cwd(), projectName)

  if (existsSync(targetDir)) {
    log.error(`Directory "${projectName}" already exists`)
    return
  }

  const copyFiles = createCopyFiles(targetDir)
  const templateFile = createTemplateFile(projectName, options, targetDir)

  if (options.addOns) {
    options.chosenAddOns = await pickAddOns(await getAllAddOns())
  }

  const isAddOnEnabled = (id: string) =>
    options.chosenAddOns.find((a) => a.id === id)

  intro(`Creating a new TanStack app in ${targetDir}...`)

  // Make the root directory
  await mkdir(targetDir, { recursive: true })

  // Setup the .vscode directory
  await mkdir(resolve(targetDir, '.vscode'), { recursive: true })
  await copyFile(
    resolve(templateDirBase, '.vscode/settings.json'),
    resolve(targetDir, '.vscode/settings.json'),
  )

  // Fill the public directory
  await mkdir(resolve(targetDir, 'public'), { recursive: true })
  copyFiles(templateDirBase, [
    './public/robots.txt',
    './public/favicon.ico',
    './public/manifest.json',
    './public/logo192.png',
    './public/logo512.png',
  ])

  // Make the src directory
  await mkdir(resolve(targetDir, 'src'), { recursive: true })
  if (options.mode === FILE_ROUTER) {
    await mkdir(resolve(targetDir, 'src/routes'), { recursive: true })
    await mkdir(resolve(targetDir, 'src/components'), { recursive: true })
  }

  // Copy in Vite and Tailwind config and CSS
  if (!options.tailwind) {
    await copyFiles(templateDirBase, ['./src/App.css'])
  }
  await templateFile(templateDirBase, './vite.config.js.ejs')
  await templateFile(templateDirBase, './src/styles.css.ejs')

  copyFiles(templateDirBase, ['./src/logo.svg'])

  // Setup the app component. There are four variations, typescript/javascript and tailwind/non-tailwind.
  if (options.mode === FILE_ROUTER) {
    await templateFile(
      templateDirRouter,
      './src/components/Header.tsx.ejs',
      './src/components/Header.tsx',
    )
    await templateFile(
      templateDirRouter,
      './src/routes/__root.tsx.ejs',
      './src/routes/__root.tsx',
    )
    await templateFile(
      templateDirBase,
      './src/App.tsx.ejs',
      './src/routes/index.tsx',
    )
  } else {
    await templateFile(
      templateDirBase,
      './src/App.tsx.ejs',
      options.typescript ? undefined : './src/App.jsx',
    )
    await templateFile(
      templateDirBase,
      './src/App.test.tsx.ejs',
      options.typescript ? undefined : './src/App.test.jsx',
    )
  }

  // Create the main entry point
  if (!isAddOnEnabled('start')) {
    if (options.typescript) {
      await templateFile(templateDirRouter, './src/main.tsx.ejs')
    } else {
      await templateFile(
        templateDirRouter,
        './src/main.tsx.ejs',
        './src/main.jsx',
      )
    }
  }

  // Setup the main, reportWebVitals and index.html files
  if (!isAddOnEnabled('start')) {
    if (options.typescript) {
      await templateFile(templateDirBase, './src/reportWebVitals.ts.ejs')
    } else {
      await templateFile(
        templateDirBase,
        './src/reportWebVitals.ts.ejs',
        './src/reportWebVitals.js',
      )
    }
    await templateFile(templateDirBase, './index.html.ejs')
  }

  // Setup tsconfig
  if (options.typescript) {
    await templateFile(
      templateDirBase,
      './tsconfig.json.ejs',
      './tsconfig.json',
    )
  }

  // Setup the package.json file, optionally with typescript and tailwind
  await createPackageJSON(
    projectName,
    options,
    templateDirBase,
    templateDirRouter,
    targetDir,
    options.chosenAddOns.map((addOn) => addOn.packageAdditions),
  )

  // Copy all the asset files from the addons
  const s = spinner()
  for (const phase of ['setup', 'add-on']) {
    for (const addOn of options.chosenAddOns.filter(
      (addOn) => addOn.phase === phase,
    )) {
      s.start(`Setting up ${addOn.name}...`)
      const addOnDir = resolve(addOn.directory, 'assets')
      if (existsSync(addOnDir)) {
        await copyFilesRecursively(
          addOnDir,
          targetDir,
          copyFile,
          async (file: string, targetFileName?: string) =>
            templateFile(addOnDir, file, targetFileName),
        )
      }

      if (addOn.command) {
        await execa(addOn.command.command, addOn.command.args || [], {
          cwd: targetDir,
        })
      }
      s.stop(`${addOn.name} setup complete`)
    }
  }

  if (isAddOnEnabled('shadcn')) {
    const shadcnComponents = new Set<string>()
    for (const addOn of options.chosenAddOns) {
      if (addOn.shadcnComponents) {
        for (const component of addOn.shadcnComponents) {
          shadcnComponents.add(component)
        }
      }
    }

    if (shadcnComponents.size > 0) {
      s.start(
        `Installing shadcn components (${Array.from(shadcnComponents).join(', ')})...`,
      )
      await execa('npx', ['shadcn@canary', 'add', ...shadcnComponents], {
        cwd: targetDir,
      })
      s.stop(`Installed shadcn components`)
    }
  }

  const warnings: Array<string> = []
  for (const addOn of options.chosenAddOns) {
    if (addOn.warning) {
      warnings.push(addOn.warning)
    }
  }

  // Add .gitignore
  await copyFile(
    resolve(templateDirBase, 'gitignore'),
    resolve(targetDir, '.gitignore'),
  )

  // Create the README.md
  await templateFile(templateDirBase, 'README.md.ejs')

  // Install dependencies
  s.start(`Installing dependencies via ${options.packageManager}...`)
  await execa(options.packageManager, ['install'], { cwd: targetDir })
  s.stop(`Installed dependencies`)

  if (warnings.length > 0) {
    log.warn(chalk.red(warnings.join('\n')))
  }

  outro(`Created your new TanStack app in ${targetDir}.

Use the following commands to start your app:

% cd ${projectName}
% ${options.packageManager} ${isAddOnEnabled('start') ? 'dev' : 'start'}

Please read README.md for more information on testing, styling, adding routes, react-query, etc.
`)
}

program
  .name('create-tsrouter-app')
  .description('CLI to create a new TanStack application')
  .argument('<project-name>', 'name of the project')
  .option<'typescript' | 'javascript' | 'file-router'>(
    '--template <type>',
    'project template (typescript, javascript, file-router)',
    (value) => {
      if (
        value !== 'typescript' &&
        value !== 'javascript' &&
        value !== 'file-router'
      ) {
        throw new InvalidArgumentError(
          `Invalid template: ${value}. Only the following are allowed: typescript, javascript, file-router`,
        )
      }
      return value
    },
    'javascript',
  )
  .option<PackageManager>(
    `--package-manager <${SUPPORTED_PACKAGE_MANAGERS.join('|')}>`,
    `Explicitly tell the CLI to use this package manager`,
    (value) => {
      if (!SUPPORTED_PACKAGE_MANAGERS.includes(value as PackageManager)) {
        throw new InvalidArgumentError(
          `Invalid package manager: ${value}. Only the following are allowed: ${SUPPORTED_PACKAGE_MANAGERS.join(
            ', ',
          )}`,
        )
      }
      return value as PackageManager
    },
    getPackageManager(),
  )
  .option('--tailwind', 'add Tailwind CSS', false)
  .option('--add-ons', 'pick from a list of available add-ons', false)
  .action(
    (
      projectName: string,
      options: {
        template: 'typescript' | 'javascript' | 'file-router'
        tailwind: boolean
        packageManager: PackageManager
        addOns: boolean
      },
    ) => {
      if (options.addOns) {
        if (options.template !== 'file-router') {
          throw new InvalidArgumentError(
            'Add-ons are only available for the file-router template',
          )
        }
        options.tailwind = true
      }

      const typescript =
        options.template === 'typescript' || options.template === 'file-router'

      createApp(projectName, {
        typescript,
        tailwind: options.tailwind,
        packageManager: options.packageManager,
        mode: options.template === 'file-router' ? FILE_ROUTER : CODE_ROUTER,
        addOns: options.addOns,
        chosenAddOns: [],
      })
    },
  )

program.parse()
