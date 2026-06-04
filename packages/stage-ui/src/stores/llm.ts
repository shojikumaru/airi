import type { StreamOptions } from '@proj-airi/core-agent'
import type { WebSocketEvents } from '@proj-airi/server-sdk'
import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message, Tool } from '@xsai/shared-chat'

import { streamFrom as coreStreamFrom, isContentArrayRelatedError, isToolRelatedError, modelKey } from '@proj-airi/core-agent'
import { listModels } from '@xsai/model'
import { uniqBy } from 'es-toolkit'
import { defineStore } from 'pinia'
import { ref } from 'vue'

import { createSparkCommandTool, debug, mcp } from '../tools'
import { useLlmToolsStore } from './llm-tools'
import { useModsServerChannelStore } from './mods/api/channel-server'

export type { StreamEvent, StreamOptions } from '@proj-airi/core-agent'
export { isContentArrayRelatedError, isToolRelatedError } from '@proj-airi/core-agent'

function messageContentToText(content: unknown): string {
  if (typeof content === 'string')
    return content

  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string')
        return part
      if (part && typeof part === 'object' && 'text' in part)
        return String((part as { text?: unknown }).text ?? '')
      return ''
    }).join('')
  }

  if (content == null)
    return ''

  return String(content)
}

let catyLastSpeechText = ''
let catyLastSpeechAt = 0

async function playCatyBridgeSpeech(text: string) {
  const normalizedText = text.trim()
  const now = performance.now()

  if (!normalizedText || normalizedText.length < 2) {
    console.info('[caty voice] skipped empty/short response')
    return
  }

  if (normalizedText === catyLastSpeechText && now - catyLastSpeechAt < 3000) {
    console.info('[caty voice] skipped duplicate response')
    return
  }

  catyLastSpeechText = normalizedText
  catyLastSpeechAt = now
  const startedAt = performance.now()

  try {
    const response = await fetch('/caty-bridge/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'caty-fish',
        voice: 'caty',
        input: normalizedText,
        response_format: 'mp3',
      }),
    })

    const ttsLatencyMs = response.headers.get('X-Caty-TTS-Latency-Ms')
    const audioBytes = response.headers.get('X-Caty-Audio-Bytes')
    console.info('[caty voice] speech response', {
      status: response.status,
      ok: response.ok,
      ttsLatencyMs,
      audioBytes,
      fetchLatencyMs: Math.round(performance.now() - startedAt),
    })

    if (!response.ok) {
      console.warn(`Caty bridge speech returned HTTP ${response.status}`)
      return
    }

    const blob = await response.blob()
    if (blob.size < 128) {
      console.warn('[caty voice] skipped tiny audio blob', { size: blob.size })
      return
    }

    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    audio.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true })
    await audio.play()
    console.info('[caty voice] playback started', {
      playbackLatencyMs: Math.round(performance.now() - startedAt),
      blobBytes: blob.size,
    })
  }
  catch (error) {
    console.warn('[caty voice] speech playback failed', error)
  }
}

async function streamFromCatyBridge(messages: Message[], options?: StreamOptions) {
  const lastUserMessage = [...messages].reverse().find(message => message.role === 'user')
  const message = messageContentToText(lastUserMessage?.content).trim()

  if (!message)
    throw new Error('Caty bridge received an empty user message')

  const response = await fetch('/caty-bridge/v1/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message,
      surface: 'airi-stage-web',
    }),
  })

  const raw = await response.text()
  let data: { text?: string, error?: { message?: string } }
  try {
    data = JSON.parse(raw)
  }
  catch {
    data = { text: raw }
  }

  if (!response.ok)
    throw new Error(data.error?.message || `Caty bridge returned HTTP ${response.status}`)

  const answer = data.text?.trim()
  if (!answer)
    throw new Error('Caty bridge returned an empty response')

  await options?.onStreamEvent?.({ type: 'text-delta', text: answer })
  void playCatyBridgeSpeech(answer)
  await options?.onStreamEvent?.({ type: 'finish' })
}

function toolNameFrom(tool: Tool) {
  const candidate = tool as Tool & {
    name?: string
    function?: {
      name?: string
    }
  }

  return candidate.function?.name ?? candidate.name
}

export const useLLM = defineStore('llm', () => {
  const toolsCompatibility = ref<Map<string, boolean>>(new Map())
  const contentArrayCompatibility = ref<Map<string, boolean>>(new Map())
  const modsServerChannelStore = useModsServerChannelStore()
  const llmToolsStore = useLlmToolsStore()

  async function stream(model: string, chatProvider: ChatProvider, messages: Message[], options?: StreamOptions) {
    if (model === 'caty-openclaw-bridge') {
      await streamFromCatyBridge(messages, options)
      return
    }

    const key = modelKey(model, chatProvider)
    // TODO(@nekomeowww,@shinohara-rin): we should not register the command callback on every stream anyway...
    const sendSparkCommand = (command: WebSocketEvents['spark:command']) => {
      // TODO(@nekomeowww): instruct the LLM to understand what destination is.
      // Currently without skill like prompt injection, many issues occur.
      // destination mostly are wrong or hallucinated, we need to find a way to make it more reliable.
      //
      // For now, since destinations as array will always broadcast to all connected modules/agents, we can set it to
      // empty array to avoid wrong routing.
      command.destinations = []

      modsServerChannelStore.send({
        type: 'spark:command',
        data: command,
      })
    }

    const builtinToolsResolver = async () => {
      await llmToolsStore.awaitPendingRegistrations()

      // Reverse twice so later runtime registrations win while original tool order stays stable.
      return uniqBy(
        [
          ...await mcp(),
          ...await debug(),
          ...await createSparkCommandTool({ sendSparkCommand }),
          ...await llmToolsStore.activeTools,
        ].toReversed(),
        tool => toolNameFrom(tool) ?? tool,
      ).toReversed()
    }

    const runStream = () => coreStreamFrom({
      model,
      chatProvider,
      messages,
      options: {
        ...options,
        toolsCompatibility: toolsCompatibility.value,
        contentArrayCompatibility: contentArrayCompatibility.value,
      },
      builtinToolsResolver,
    })

    try {
      await runStream()
    }
    catch (err) {
      if (isToolRelatedError(err)) {
        console.warn(`[llm] Auto-disabling tools for "${key}" due to tool-related error`)
        toolsCompatibility.value.set(key, false)
      }
      // NOTICE:
      // Auto-degrade content-part arrays to plain strings on the next attempt
      // when the provider returned the Rust/serde-style "expected a string"
      // 400. We retry once inline so the user's failing turn recovers without
      // requiring them to resend; subsequent calls reuse the cached degrade.
      // See: https://github.com/moeru-ai/airi/issues/1500
      if (isContentArrayRelatedError(err) && contentArrayCompatibility.value.get(key) !== false) {
        console.warn(`[llm] Auto-disabling content-part arrays for "${key}" and retrying once`)
        contentArrayCompatibility.value.set(key, false)
        await runStream()
        return
      }
      throw err
    }
  }

  async function models(apiUrl: string, apiKey: string) {
    if (apiUrl === '')
      return []

    try {
      return await listModels({
        baseURL: (apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`) as `${string}/`,
        apiKey,
      })
    }
    catch (err) {
      if (String(err).includes(`Failed to construct 'URL': Invalid URL`))
        return []
      throw err
    }
  }

  return {
    models,
    stream,
  }
})
