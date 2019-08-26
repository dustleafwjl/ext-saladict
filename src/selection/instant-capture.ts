import { getText, getSentence } from 'get-selection-more'
import { DeepNonNullable } from 'utility-types'
import { AppConfig } from '@/app-config'
import { isStandalonePage, isInDictPanel } from '@/_helpers/saladict'
import { checkSupportedLangs } from '@/_helpers/lang-check'
import { Word, newWord } from '@/_helpers/record-manager'

import { fromEvent, merge, of, Observable, timer, combineLatest } from 'rxjs'
import {
  map,
  mapTo,
  filter,
  switchMap,
  distinctUntilChanged,
  debounce
} from 'rxjs/operators'

import { isBlacklisted } from './helper'

/**
 * Create an instant capture Observable
 */
export function createIntantCaptureStream(
  config$: Observable<AppConfig>,
  isPinned$: Observable<boolean>,
  withQSPanel$: Observable<boolean>
) {
  return combineLatest(config$, isPinned$, withQSPanel$).pipe(
    switchMap(([config, isPinned, withQSPanel]) => {
      if (isBlacklisted(config)) return of(null)

      const { instant: panelInstant } = config.panelMode
      const { instant: otherInstant } = config[
        withQSPanel ? 'qsPanelMode' : isPinned ? 'pinMode' : 'mode'
      ]

      if (!panelInstant.enable && !otherInstant.enable) {
        return of(null)
      }

      // Reduce GC
      // Only the latest result is used so it's safe to reuse the object
      const reuseObj = ({} as unknown) as {
        event: MouseEvent
        config: AppConfig
        self: boolean
      }

      return merge(
        mapTo(null)(fromEvent(window, 'mouseup', { capture: true })),
        mapTo(null)(fromEvent(window, 'mouseout', { capture: true })),
        fromEvent<MouseEvent>(window, 'mousemove', { capture: true }).pipe(
          map(event => {
            const self = isInDictPanel(event.target)
            const instant =
              self || isStandalonePage() ? panelInstant : otherInstant
            if (instant.enable) {
              if (
                (instant.key === 'alt' && event.altKey) ||
                (instant.key === 'shift' && event.shiftKey) ||
                (instant.key === 'ctrl' && (event.ctrlKey || event.metaKey)) ||
                (instant.key === 'direct' &&
                  !(event.ctrlKey || event.metaKey || event.altKey))
              ) {
                reuseObj.event = event
                reuseObj.config = config
                reuseObj.self = self
                return reuseObj
              }
            }
            return null
          })
        )
      ).pipe(
        debounce(obj =>
          obj ? timer(obj.self ? panelInstant.delay : otherInstant.delay) : of()
        )
      )
    }),
    map(obj => obj && { word: getCursorWord(obj.event), ...obj }),
    filter((obj): obj is {
      word: Word
      event: MouseEvent
      config: AppConfig
      self: boolean
    } =>
      Boolean(
        obj &&
          obj.word &&
          checkSupportedLangs(obj.config.language, obj.word.text)
      )
    ),
    distinctUntilChanged(
      (oldObj, newObj) =>
        oldObj.word.text === newObj.word.text &&
        oldObj.word.context === newObj.word.context
    )
  )
}

function getCursorWord(event: MouseEvent): Word | null {
  const x = event.clientX
  const y = event.clientY

  let offsetNode: Node
  let offset: number
  let originRange: Range | undefined

  const sel = window.getSelection()
  if (!sel) return null
  if (sel.rangeCount > 0) {
    originRange = sel.getRangeAt(0)
  }

  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y)
    if (!pos) return null
    offsetNode = pos.offsetNode
    offset = pos.offset
  } else if (document.caretRangeFromPoint) {
    const pos = document.caretRangeFromPoint(x, y)
    if (!pos) return null
    offsetNode = pos.startContainer
    offset = pos.startOffset
  } else {
    return null
  }

  if (offsetNode.nodeType === Node.TEXT_NODE) {
    const textNode = offsetNode as Text
    const content = textNode.data
    const head = (content.slice(0, offset).match(/[-_a-z]+$/i) || [''])[0]
    const tail = (content
      .slice(offset)
      .match(/^([-_a-z]+|[\u4e00-\u9fa5])/i) || [''])[0]
    if (head.length <= 0 && tail.length <= 0) {
      return null
    }

    const range = document.createRange()
    range.setStart(textNode, offset - head.length)
    range.setEnd(textNode, offset + tail.length)
    const rangeRect = range.getBoundingClientRect()

    if (
      rangeRect.left <= x &&
      rangeRect.right >= x &&
      rangeRect.top <= y &&
      rangeRect.bottom >= y
    ) {
      sel.removeAllRanges()
      sel.addRange(range)
      if (sel['modify']) {
        sel['modify']('move', 'backward', 'word')
        sel.collapseToStart()
        sel['modify']('extend', 'forward', 'word')
      }
    }

    const text = getText()
    const context = getSentence()

    sel.removeAllRanges()
    if (originRange) {
      sel.addRange(originRange)
    }
    range.detach()

    return text ? newWord({ text, context }) : null
  }

  return null
}
