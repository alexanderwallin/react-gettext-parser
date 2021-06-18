import fs from 'fs'
import path from 'path'
import * as parser from '@babel/parser'
import traverse from '@babel/traverse'
import curry from 'lodash.curry'
import uniq from 'lodash.uniq'
import glob from 'glob-all'

import {
  GETTEXT_FUNC_ARGS_MAP,
  GETTEXT_COMPONENT_PROPS_MAP,
  BABEL_PARSING_OPTS,
} from './defaults'
import { outputPot } from './io'
import { toPot } from './json2pot'
import {
  isGettextFuncCall,
  isGettextComponent,
  getFuncName,
  getGettextStringFromNodeArgument,
} from './node-helpers'

const noop = () => {}

export const TYPESCRIPT = 'TYPESCRIPT'
export const JAVASCRIPT = 'JAVASCRIPT'

const getEmptyBlock = () => ({
  msgctxt: '',
  msgid: null,
  msgstr: [''],
  comments: {
    reference: [],
    extracted: [],
  },
})

const getBabelParsingOptions = sourceType => {
  if (sourceType === TYPESCRIPT) {
    return {
      ...BABEL_PARSING_OPTS,
      plugins: ['typescript'].concat(BABEL_PARSING_OPTS.plugins),
    }
  }
  return {
    ...BABEL_PARSING_OPTS,
    plugins: ['flow'].concat(BABEL_PARSING_OPTS.plugins),
  }
}

/**
 * Returns a gettext block given a mapping of component props to gettext
 * props and a JSXOpeningElement node
 */
const getGettextBlockFromComponent = (propsMap, node) => {
  const componentPropsLookup = propsMap[node.name.name]
  const gettextPropNames = Object.keys(componentPropsLookup)

  const propValues = node.attributes
    .filter(attr => gettextPropNames.indexOf(attr.name.name) !== -1)
    .reduce(
      (props, attr) => ({
        ...props,
        [attr.name.name]: getGettextStringFromNodeArgument(attr),
      }),
      {}
    )

  const block = Object.keys(propValues).reduce((currBlock, propName) => {
    const gettextVar = componentPropsLookup[propName]
    const value = propValues[propName]

    if (gettextVar === 'msgid') {
      currBlock.msgid = value
    } else if (gettextVar === 'msgid_plural') {
      currBlock.msgid_plural = value
      currBlock.msgstr = ['', '']
    } else if (gettextVar === 'msgctxt') {
      currBlock.msgctxt = value
    } else if (gettextVar === 'comment') {
      currBlock.comments.extracted.push(value)
    }

    return currBlock
  }, getEmptyBlock())

  return block
}

/**
 * Returns whether two gettext blocks are considered equal
 */
export const areBlocksEqual = curry(
  (a, b) => a.msgid === b.msgid && a.msgctxt === b.msgctxt
)

/**
 * Returns whether two gettext reference comment are considered equal
 */
const areReferencesEqual = curry(
  (a, b) =>
    a.filename === b.filename && a.line === b.line && a.column === b.column
)

const compareReference = (a, b) => {
  if (a.filename === b.filename) {
    if (a.line === b.line) {
      return a.column - b.column
    }
    return a.line - b.line
  }
  return a.filename.localeCompare(b.filename)
}

/**
 * Returns a file path relative to the current working directory
 */
const getRelativeReferencePath = filepath => {
  if (typeof filepath === 'string') {
    return path.relative(process.cwd(), path.resolve(filepath))
  }

  // Return filepath as is (could be null och undefined or whatever)
  return filepath
}

/**
 * Takes a list of blocks and returns a list with unique ones.
 * Translator comments and source code reference comments are
 * concatenated.
 */
export const getUniqueBlocks = blocks =>
  blocks
    .filter(x => x.msgid && x.msgid.trim())
    .reduce((unique, block) => {
      const isEqualBlock = areBlocksEqual(block)
      const existingBlock = unique.filter(x => isEqualBlock(x)).shift()

      if (existingBlock) {
        // Concatenate comments to translators
        if (block.comments.extracted.length > 0) {
          existingBlock.comments.extracted = uniq(
            existingBlock.comments.extracted.concat(block.comments.extracted)
          )
        }

        // Concatenate source references
        if (block.comments.reference.length > 0) {
          existingBlock.comments.reference = uniq(
            existingBlock.comments.reference.concat(block.comments.reference),
            areReferencesEqual
          ).sort(compareReference)
        }

        // Add plural id and overwrite msgstr
        if (block.msgid_plural) {
          existingBlock.msgid_plural = block.msgid_plural
          existingBlock.msgstr = block.msgstr
        }

        return unique.map(x => (isEqualBlock(x) ? existingBlock : x))
      }

      return unique.concat(block)
    }, [])

/**
 * Traverser
 *
 * The traverser is wrapped inside a function so that it can be used both
 * by passing options manually and as a babel plugin.
 *
 * Options contain component and function mappings, as well as an optional
 * filename, which is used to add source code reference comments to the
 * pot file.
 *
 * Traversers in Babel plugins retrieves plugin options as a `state` argument
 * to each visitor, hence the `state.opts || opts`.
 */
export const getTraverser = (cb = noop, opts = {}) => {
  const blocks = []

  return {
    Program: {
      enter(astPath, state = {}) {
        state.opts = {
          ...state.opts,
          ...opts,
          filename: getRelativeReferencePath(
            state.file ? state.file.opts.filename : opts.filename
          ),
        }
      },

      exit(astPath, state = {}) {
        cb(getUniqueBlocks(blocks), { opts: state.opts || opts })
      },
    },

    /**
     * React gettext components, e.g.:
     *
     *  <GetText message="My string" comment="Some clarifying comment" />
     */
    JSXOpeningElement: {
      enter(astPath, state = {}) {
        const { node, parent } = astPath
        const envOpts = state.opts || opts
        const propsMap =
          envOpts.componentPropsMap || GETTEXT_COMPONENT_PROPS_MAP

        if (isGettextComponent(Object.keys(propsMap), node) === false) {
          return
        }

        if (parent.children.length > 0) {
          return
        }

        const block = getGettextBlockFromComponent(propsMap, node)

        if (envOpts.filename) {
          block.comments.reference = [
            {
              filename: getRelativeReferencePath(envOpts.filename),
              line: node.loc.start.line,
              column: node.loc.start.column,
            },
          ]
        }

        blocks.push(block)
      },
    },

    /**
     * React component inline text, e.g.:
     *
     *  <GetText>My string</GetText>
     */
    JSXText: {
      enter(astPath, state = {}) {
        const { node, parent } = astPath
        const envOpts = state.opts || opts
        const propsMap =
          envOpts.componentPropsMap || GETTEXT_COMPONENT_PROPS_MAP

        if (
          isGettextComponent(Object.keys(propsMap), parent.openingElement) ===
          false
        ) {
          return
        }

        const block = getGettextBlockFromComponent(
          propsMap,
          parent.openingElement
        )
        block.msgid = node.value

        if (envOpts.filename) {
          block.comments.reference = [
            {
              filename: getRelativeReferencePath(envOpts.filename),
              line: node.loc.start.line,
              column: node.loc.start.column,
            },
          ]
        }

        blocks.push(block)
      },
    },

    /**
     * JSX expressions, a.k.a. strings inside curly braces:
     *
     * <GetText>{'Phrase goes here'}</GetText>
     * <GetText>{`Text inside backticks`}</GetText>
     */
    JSXExpressionContainer: {
      enter(astPath, state = {}) {
        const { node, parent } = astPath
        const envOpts = state.opts || opts
        const propsMap =
          envOpts.componentPropsMap || GETTEXT_COMPONENT_PROPS_MAP

        if (
          isGettextComponent(Object.keys(propsMap), parent.openingElement) ===
          false
        ) {
          return
        }

        const value = getGettextStringFromNodeArgument(node.expression)

        if (typeof value === 'string' && value.trim() !== '') {
          const block = getEmptyBlock()
          block.msgid = value

          if (envOpts.filename) {
            block.comments.reference = [
              {
                filename: getRelativeReferencePath(envOpts.filename),
                line: node.loc.start.line,
                column: node.loc.start.column,
              },
            ]
          }

          blocks.push(block)
        }
      },
    },

    /**
     * Gettext function calls, e.g.:
     * ngettext('One item', '{{ count }} items');
     */
    CallExpression: {
      enter(astPath, state = {}) {
        const { node, parent } = astPath
        const envOpts = state.opts || opts

        const funcArgsMap = envOpts.funcArgumentsMap || GETTEXT_FUNC_ARGS_MAP
        const funcNames = Object.keys(funcArgsMap)

        if (isGettextFuncCall(funcNames, node) === false) {
          return
        }

        const mappedArgs = funcArgsMap[getFuncName(node)]
        const block = mappedArgs
          .map((arg, i) => {
            if (!arg || !node.arguments[i]) {
              return {}
            }

            // The argument maps directly to a gettext property
            if (typeof arg === 'string') {
              const stringValue = getGettextStringFromNodeArgument(
                node.arguments[i]
              )
              return { [arg]: stringValue }
            }

            // The argument is an object mapping key names to gettext props
            return Object.keys(arg).reduce((acc, prop) => {
              const gettextPropName = arg[prop]
              const matchingObjectValue = node.arguments[i].properties.find(
                x => x.key.name === prop
              ).value.value
              return gettextPropName === 'comment'
                ? {
                    ...acc,
                    comments: {
                      extracted: [matchingObjectValue],
                    },
                  }
                : {
                    ...acc,
                    [gettextPropName]: matchingObjectValue,
                  }
            }, {})
          })
          .reduce((a, b) => ({ ...a, ...b }), getEmptyBlock())

        if (block.msgid_plural) {
          block.msgstr = ['', '']
        }

        // Extract comments for translators
        if (Array.isArray(parent.leadingComments) === true) {
          const translatorCommentRegex = /Translators:.+/
          const commentNode = parent.leadingComments.find(
            x => translatorCommentRegex.test(x.value) === true
          )

          if (commentNode !== undefined) {
            const commentLine = commentNode.value
              .split(/\n/)
              .find(x => translatorCommentRegex.test(x))

            if (commentLine !== undefined) {
              const comment = commentLine
                .replace(/^\s*\*/, '')
                .replace(/Translators:/, '')
                .trim()
              block.comments.extracted = [comment]
            }
          }
        }

        if (envOpts.filename) {
          block.comments.reference = [
            {
              filename: getRelativeReferencePath(envOpts.filename),
              line: node.loc.start.line,
              column: node.loc.start.column,
            },
          ]
        }
        blocks.push(block)
      },
    },
  }
}

/**
 * Parses and returns extracted gettext blocks from a js contents
 */
export const extractMessages = (code, opts = {}) => {
  let blocks = []

  const ast = parser.parse(
    code.toString('utf8'),
    getBabelParsingOptions(opts.sourceType)
  )
  const traverser = getTraverser(_blocks => {
    blocks = _blocks
  }, opts)

  traverse(ast, traverser)

  // Remove whitespace according to options
  if (opts.trim) {
    blocks = blocks.map(block => ({
      ...block,
      msgid: block.msgid.trim(),
    }))
  }
  if (opts.trimLines) {
    blocks = blocks.map(block => ({
      ...block,
      msgid: block.msgid
        .split('\n')
        .map(x => x.trim())
        .filter(x => x)
        .join('\n'),
    }))
  }
  if (opts.trimNewlines) {
    const replaceValue =
      typeof opts.trimNewlines === 'string' ? opts.trimNewlines : ''
    blocks = blocks.map(block => ({
      ...block,
      msgid: block.msgid.replace(/\n/g, replaceValue),
    }))
  }

  if (Array.isArray(opts.overrideContext) && opts.overrideContext.length > 0) {
    blocks = blocks.reduce((acc, block) => {
      // If we havea  msgctxt and it's no the default '' empty context (would be a literal or undefined if a variable)
      if ("msgctxt" in block && block.msgctxt !== '') {
        return [
          ...acc, 
          ...opts.overrideContext.map((override) => ({...block, msgctxt: override}))
        ];
      }
      return [...acc, block];
    }, []);
  }
  return blocks
}

/**
 * Parses and returns extracted gettext blocks from a file at a given path
 */
export const extractMessagesFromFile = (file, opts = {}) =>
  extractMessages(fs.readFileSync(file, 'utf8'), {
    ...opts,
    filename: file,
    sourceType:
      file.endsWith('.ts') || file.endsWith('.tsx') ? TYPESCRIPT : JAVASCRIPT,
  })

/**
 * Parses and returns extracted gettext blocks from all files matching a glob
 */
export const extractMessagesFromGlob = (globArr, opts = {}) => {
  const blocks = glob
    .sync(globArr)
    .reduce((all, file) => all.concat(extractMessagesFromFile(file, opts)), [])

  return getUniqueBlocks(blocks)
}

/**
 * Parses a string for gettext blocks and writes them to a .pot file
 */
export const parse = (code, opts = {}, cb = noop) => {
  const blocks = extractMessages(code, opts)
  outputPot(
    opts.output,
    toPot(blocks, {
      transformHeaders: opts.transformHeaders,
      disableLineNumbers: opts.disableLineNumbers,
    }),
    cb
  )
}

/**
 * Parses a file at a given path for gettext blocks and writes them
 * to a .pot file
 */
export const parseFile = (file, opts = {}, cb = noop) => {
  const blocks = extractMessagesFromFile(file, opts)
  outputPot(
    opts.output,
    toPot(blocks, {
      transformHeaders: opts.transformHeaders,
      disableLineNumbers: opts.disableLineNumbers,
    }),
    cb
  )
}

/**
 * Parses all files matching a glob and extract blocks from all of them,
 * then writing them to a .pot file
 */
export const parseGlob = (globArr, opts = {}, cb = noop) => {
  const blocks = extractMessagesFromGlob(globArr, opts)
  outputPot(
    opts.output,
    toPot(blocks, {
      transformHeaders: opts.transformHeaders,
      disableLineNumbers: opts.disableLineNumbers,
    }),
    cb
  )
}
