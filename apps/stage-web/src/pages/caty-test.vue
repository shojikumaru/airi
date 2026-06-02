<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'

interface CatyBridgeResponse {
  text?: string
  emotion?: string
  actions?: unknown[]
  metadata?: {
    agent?: string
    latency_ms?: number
    session_id?: string | null
  }
  error?: {
    code?: string
    message?: string
  }
}

const message = ref('広報caty、Ceroからの接続テストです。短く自己紹介してください。')
const response = ref<CatyBridgeResponse | null>(null)
const rawResponse = ref('')
const error = ref('')
const loading = ref(false)
const didVideoUrl = ref('/caty-did-demo/did-caty-result.mp4')
const didVideoCacheBust = ref(Date.now())
const didGenerating = ref(false)
const didError = ref('')
const didResult = ref<Record<string, unknown> | null>(null)

const sttListening = ref(false)
const sttTranscript = ref('')
const sttInterim = ref('')
const sttError = ref('')
const sttStatus = ref('idle')
const sttRestartCount = ref(0)
let activeRecognition: any | null = null
let sttKeepListening = false
let sttRestartTimer: number | null = null

const ttsGenerating = ref(false)
const ttsError = ref('')
const ttsAudioUrl = ref('')
const ttsLatencyMs = ref('')
const ttsAudioBytes = ref('')
const ttsPlaybackState = ref('idle')
const autoPlayTts = ref(true)
const ttsAutoplayPrimed = ref(false)
const ttsAudioElement = ref<HTMLAudioElement | null>(null)
let ttsAudioBlob: Blob | null = null
let ttsAudioContext: AudioContext | null = null
let activeTtsSource: AudioBufferSourceNode | null = null

const speechRecognitionSupported = computed(() => {
  if (typeof window === 'undefined')
    return false
  return Boolean((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)
})

function shouldCacheBustDidVideoUrl(url: string) {
  try {
    const parsed = new URL(url, window.location.href)
    // D-ID result_url is a pre-signed S3 URL. Adding arbitrary query params breaks
    // the AWS signature and the <video> element silently falls back to a black box.
    if (parsed.searchParams.has('X-Amz-Signature') || parsed.hostname.endsWith('amazonaws.com'))
      return false

    return parsed.origin === window.location.origin
  }
  catch {
    return !/^https?:\/\//i.test(url)
  }
}

const didVideoSrc = computed(() => {
  const url = didVideoUrl.value.trim().replaceAll('&amp;', '&')
  if (!url)
    return ''

  if (!shouldCacheBustDidVideoUrl(url))
    return url

  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}catyDidBust=${didVideoCacheBust.value}`
})
const didVideoKey = computed(() => `${didVideoSrc.value}#${didVideoCacheBust.value}`)

function refreshDidVideo() {
  didVideoCacheBust.value = Date.now()
}

const canGenerateDid = computed(() => Boolean(response.value?.text) && !didGenerating.value)

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function stripEmojiForSpeech(text: string) {
  // Fish Audio can vocalize emoji/symbols as unexpected words. Keep the visible
  // Caty response intact, but feed speech synthesis a calmer text-only variant.
  return text
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F\u200D]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function clearSttRestartTimer() {
  if (sttRestartTimer !== null) {
    window.clearTimeout(sttRestartTimer)
    sttRestartTimer = null
  }
}

async function primeTtsPlayback() {
  if (typeof window === 'undefined')
    return

  try {
    const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext
    if (!AudioContextCtor)
      return

    if (!ttsAudioContext)
      ttsAudioContext = new AudioContextCtor()

    if (ttsAudioContext.state !== 'running')
      await ttsAudioContext.resume()

    ttsAutoplayPrimed.value = ttsAudioContext.state === 'running'
  }
  catch (err) {
    ttsAutoplayPrimed.value = false
    ttsError.value = err instanceof Error ? `自動再生の準備に失敗しました: ${err.message}` : '自動再生の準備に失敗しました。'
  }
}

function stopVoiceInput() {
  sttKeepListening = false
  clearSttRestartTimer()
  if (activeRecognition) {
    try {
      activeRecognition.stop()
    }
    catch {
      // Already stopped; Web Speech API is rather theatrical about lifecycle errors.
    }
  }
  sttListening.value = false
  sttStatus.value = 'stopped'
}

function startVoiceInput() {
  if (typeof window === 'undefined')
    return

  void primeTtsPlayback()
  sttError.value = ''
  sttTranscript.value = ''
  sttInterim.value = ''
  sttRestartCount.value = 0
  sttKeepListening = true
  clearSttRestartTimer()

  const Recognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  if (!Recognition) {
    sttError.value = 'このブラウザでは Web Speech API が使えません。Chrome系ブラウザで試してください。'
    sttKeepListening = false
    return
  }

  if (activeRecognition) {
    try { activeRecognition.stop() }
    catch {}
  }

  const startRecognition = () => {
    const recognition = new Recognition()
    activeRecognition = recognition
    recognition.lang = 'ja-JP'
    recognition.continuous = true
    recognition.interimResults = true
    recognition.maxAlternatives = 1

    recognition.onstart = () => {
      sttListening.value = true
      sttStatus.value = 'listening'
      if (ttsPlaybackState.value === 'idle')
        ttsPlaybackState.value = 'listening'
    }

    recognition.onresult = (event: any) => {
      let finalText = ''
      let interimText = ''
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i]
        const text = result?.[0]?.transcript || ''
        if (result?.isFinal)
          finalText += text
        else
          interimText += text
      }

      if (finalText) {
        sttTranscript.value = `${sttTranscript.value} ${finalText}`.replace(/\s+/g, ' ').trim()
        message.value = sttTranscript.value
      }
      sttInterim.value = interimText.trim()
      if (!finalText && interimText)
        message.value = `${sttTranscript.value} ${interimText}`.trim()
    }

    recognition.onerror = (event: any) => {
      const code = event?.error || 'unknown'
      if (code === 'no-speech' && sttKeepListening) {
        sttStatus.value = 'no-speech-restarting'
        return
      }
      sttError.value = `音声認識エラー: ${code}`
      if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'aborted')
        sttKeepListening = false
    }

    recognition.onend = () => {
      sttInterim.value = ''
      if (activeRecognition === recognition)
        activeRecognition = null

      if (sttKeepListening) {
        sttStatus.value = 'restarting'
        sttRestartTimer = window.setTimeout(() => {
          sttRestartCount.value += 1
          startRecognition()
        }, 250)
        return
      }

      sttListening.value = false
      sttStatus.value = 'ended'
      if (ttsPlaybackState.value === 'listening')
        ttsPlaybackState.value = 'idle'
    }

    try {
      recognition.start()
    }
    catch (err) {
      sttError.value = err instanceof Error ? err.message : String(err)
      sttListening.value = false
      sttKeepListening = false
      sttStatus.value = 'error'
    }
  }

  startRecognition()
}

async function playTtsAudio() {
  ttsError.value = ''

  try {
    if (activeTtsSource) {
      try { activeTtsSource.stop() }
      catch {}
      activeTtsSource = null
    }

    if (ttsAudioBlob) {
      await primeTtsPlayback()
      if (ttsAudioContext?.state === 'running') {
        const buffer = await ttsAudioBlob.arrayBuffer()
        const audioBuffer = await ttsAudioContext.decodeAudioData(buffer.slice(0))
        const source = ttsAudioContext.createBufferSource()
        source.buffer = audioBuffer
        source.connect(ttsAudioContext.destination)
        source.onended = () => {
          if (activeTtsSource === source)
            activeTtsSource = null
          ttsPlaybackState.value = 'ended'
        }
        activeTtsSource = source
        ttsPlaybackState.value = 'playing'
        source.start()
        return
      }
    }

    await nextTick()
    if (!ttsAudioElement.value)
      throw new Error('audio element is not ready')

    ttsPlaybackState.value = 'playing'
    await ttsAudioElement.value.play()
    ttsPlaybackState.value = 'playing'
  }
  catch (err) {
    ttsPlaybackState.value = 'ready_click_play'
    ttsError.value = err instanceof Error ? `自動再生はブロックされました。再生ボタンを押してください: ${err.message}` : '自動再生はブロックされました。再生ボタンを押してください。'
  }
}

async function synthesizeTtsFromResponse(text: string) {
  const input = stripEmojiForSpeech(text)
  if (!input)
    return

  ttsGenerating.value = true
  ttsError.value = ''
  ttsLatencyMs.value = ''
  ttsAudioBytes.value = ''
  ttsPlaybackState.value = 'synthesizing'

  try {
    const res = await fetch('/caty-bridge/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, response_format: 'mp3' }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`TTS bridge returned HTTP ${res.status}: ${text.slice(0, 300)}`)
    }

    const blob = await res.blob()
    ttsAudioBlob = blob
    if (ttsAudioUrl.value)
      URL.revokeObjectURL(ttsAudioUrl.value)
    ttsAudioUrl.value = URL.createObjectURL(blob)
    ttsLatencyMs.value = res.headers.get('X-Caty-TTS-Latency-Ms') || ''
    ttsAudioBytes.value = res.headers.get('X-Caty-Audio-Bytes') || String(blob.size)
    ttsPlaybackState.value = 'ready'

    await nextTick()
    if (autoPlayTts.value)
      await playTtsAudio()
  }
  catch (err) {
    ttsError.value = err instanceof Error ? err.message : String(err)
    ttsPlaybackState.value = 'error'
  }
  finally {
    ttsGenerating.value = false
  }
}

async function generateDidFromResponse() {
  const text = response.value?.text?.trim()
  if (!text || didGenerating.value)
    return

  didGenerating.value = true
  didError.value = ''
  didResult.value = null

  try {
    const res = await fetch('/caty-bridge/v1/did/talk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        public_base_url: `${window.location.origin}/caty-public`,
        poll_timeout: 300,
        poll_interval: 3,
      }),
    })

    const data = await res.json() as Record<string, unknown>
    didResult.value = data

    if (!res.ok)
      throw new Error(stringField((data.error as Record<string, unknown> | undefined)?.message) || `D-ID bridge returned HTTP ${res.status}`)

    const didFinal = data.did_final as Record<string, unknown> | undefined
    const resultUrl = stringField(data.result_url) || stringField(didFinal?.result_url) || stringField(didFinal?.stream_url) || stringField(didFinal?.video_url)
    if (!resultUrl) {
      const didStatus = stringField(data.did_status) || stringField(data.status) || 'unknown'
      const talkId = stringField(data.talk_id)
      throw new Error(`D-ID result_url がまだ返っていません（status=${didStatus}${talkId ? `, talk_id=${talkId}` : ''}）。少し待って再実行してください。`)
    }

    didVideoUrl.value = resultUrl
    refreshDidVideo()
  }
  catch (err) {
    didError.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    didGenerating.value = false
  }
}

const canSend = computed(() => message.value.trim().length > 0 && !loading.value)

async function sendMessage() {
  if (!canSend.value)
    return

  void primeTtsPlayback()
  loading.value = true
  error.value = ''
  response.value = null
  rawResponse.value = ''
  ttsError.value = ''
  ttsPlaybackState.value = 'waiting_for_caty'

  try {
    const res = await fetch('/caty-bridge/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message.value.trim(), surface: 'airi-stage-web-caty-test' }),
    })

    const text = await res.text()
    rawResponse.value = text

    let data: CatyBridgeResponse
    try {
      data = JSON.parse(text)
    }
    catch {
      data = { text }
    }

    if (!res.ok)
      throw new Error(data.error?.message || `Bridge returned HTTP ${res.status}`)

    response.value = data
    if (data.text)
      await synthesizeTtsFromResponse(data.text)
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    loading.value = false
  }
}
</script>

<template>
  <main class="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
    <section class="mx-auto max-w-3xl border border-cyan-300/20 rounded-3xl bg-slate-900/80 p-6 shadow-2xl shadow-cyan-950/40 space-y-6">
      <div>
        <p class="text-sm text-cyan-300/80 tracking-[0.3em] uppercase">
          AIRI × OpenClaw bridge
        </p>
        <h1 class="mt-2 text-3xl font-semibold">
          広報caty 接続テスト
        </h1>
        <p class="mt-3 text-sm text-slate-300 leading-6">
          AIRI stage-web から localhost bridge 経由で OpenClaw の <code>koho-caty</code> に送信します。
        </p>
      </div>

      <label class="block space-y-2">
        <span class="text-sm text-slate-200 font-medium">送信メッセージ</span>
        <textarea
          v-model="message"
          class="min-h-32 w-full border border-slate-700 rounded-2xl bg-slate-950 p-4 text-slate-100 outline-none transition focus:border-cyan-300"
          placeholder="広報catyに話しかける内容"
        />
      </label>

      <section class="border border-sky-300/30 rounded-2xl bg-sky-950/20 p-4">
        <div class="flex flex-wrap items-center gap-3">
          <button
            class="border border-sky-300/50 rounded-full px-4 py-2 text-sm text-sky-100 font-semibold transition disabled:cursor-not-allowed hover:bg-sky-300/10 disabled:opacity-50"
            :disabled="!speechRecognitionSupported || sttListening"
            @click="startVoiceInput"
          >
            {{ sttListening ? '音声認識中…' : '🎙 日本語音声入力' }}
          </button>
          <button
            class="border border-slate-500 rounded-full px-4 py-2 text-sm text-slate-200 transition disabled:cursor-not-allowed hover:bg-slate-700/40 disabled:opacity-50"
            :disabled="!sttListening"
            @click="stopVoiceInput"
          >
            停止
          </button>
          <span class="text-xs text-slate-400">
            Web Speech API: {{ speechRecognitionSupported ? 'available' : 'not available' }} / lang=ja-JP / mode=continuous / status={{ sttStatus }} / restarts={{ sttRestartCount }}
          </span>
        </div>
        <p v-if="sttTranscript || sttInterim" class="mt-3 text-sm text-sky-100 leading-6">
          transcript: <span class="font-medium">{{ sttTranscript }}</span><span class="text-sky-300/80">{{ sttInterim }}</span>
        </p>
        <p v-if="sttError" class="mt-3 text-sm text-red-200">
          {{ sttError }}
        </p>
      </section>

      <div class="flex flex-wrap items-center gap-3">
        <button
          class="rounded-full bg-cyan-300 px-5 py-2.5 text-slate-950 font-semibold transition disabled:cursor-not-allowed hover:bg-cyan-200 disabled:opacity-50"
          :disabled="!canSend"
          @click="sendMessage"
        >
          {{ loading ? '送信中…' : 'Catyに送る' }}
        </button>
        <label class="flex items-center gap-2 text-sm text-slate-300">
          <input v-model="autoPlayTts" type="checkbox" class="accent-cyan-300">
          Caty応答後にFish Audioを自動再生
        </label>
      </div>

      <section class="border border-amber-300/30 rounded-2xl bg-amber-950/20 p-4">
        <div class="flex flex-wrap items-center gap-3">
          <p class="text-sm text-amber-100 font-medium">
            Fish Audio TTS
          </p>
          <button
            class="border border-amber-300/50 rounded-full px-4 py-2 text-sm text-amber-100 transition hover:bg-amber-300/10"
            @click="primeTtsPlayback"
          >
            自動再生を準備
          </button>
          <button
            class="border border-amber-300/50 rounded-full px-4 py-2 text-sm text-amber-100 transition disabled:cursor-not-allowed hover:bg-amber-300/10 disabled:opacity-50"
            :disabled="!ttsAudioUrl"
            @click="playTtsAudio"
          >
            ▶ 再生
          </button>
          <span class="text-xs text-slate-400">state={{ ttsPlaybackState }} / primed={{ ttsAutoplayPrimed ? 'yes' : 'no' }}</span>
        </div>
        <audio
          v-if="ttsAudioUrl"
          ref="ttsAudioElement"
          class="mt-3 w-full"
          :src="ttsAudioUrl"
          controls
          @play="ttsPlaybackState = 'playing'"
          @ended="ttsPlaybackState = 'ended'"
          @pause="ttsPlaybackState = 'paused'"
        />
        <dl class="grid mt-3 gap-2 text-sm text-slate-300 sm:grid-cols-3">
          <div>
            <dt class="text-slate-500">
              tts_latency
            </dt><dd>{{ ttsLatencyMs || '-' }} ms</dd>
          </div>
          <div>
            <dt class="text-slate-500">
              audio_bytes
            </dt><dd>{{ ttsAudioBytes || '-' }}</dd>
          </div>
          <div>
            <dt class="text-slate-500">
              status
            </dt><dd>{{ ttsGenerating ? 'generating' : ttsPlaybackState }}</dd>
          </div>
        </dl>
        <p v-if="ttsError" class="mt-3 text-sm text-red-200">
          {{ ttsError }}
        </p>
      </section>

      <section class="grid gap-4 border border-fuchsia-300/30 rounded-2xl bg-fuchsia-950/20 p-4 md:grid-cols-[minmax(0,1fr)_220px]">
        <div class="space-y-3">
          <div>
            <p class="text-sm text-fuchsia-200 font-medium">
              D-ID Avatar PoC
            </p>
            <p class="mt-1 text-xs text-slate-400 leading-5">
              生成済みD-ID動画をAIRI上に表示する最小確認です。まずは表示系だけを分離して検証します。
            </p>
          </div>

          <label class="block space-y-2">
            <span class="text-xs text-slate-300 font-medium">D-ID video URL</span>
            <input
              v-model="didVideoUrl"
              class="w-full border border-slate-700 rounded-xl bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-fuchsia-300"
              placeholder="/caty-did-demo/did-caty-result.mp4 or D-ID result_url"
            >
          </label>

          <div class="flex flex-wrap gap-2">
            <button
              class="border border-fuchsia-300/50 rounded-full px-4 py-2 text-sm text-fuchsia-100 font-semibold transition hover:bg-fuchsia-300/10"
              type="button"
              @click="refreshDidVideo"
            >
              動画を再読み込み
            </button>

            <button
              class="rounded-full bg-fuchsia-300 px-4 py-2 text-sm text-slate-950 font-semibold transition disabled:cursor-not-allowed hover:bg-fuchsia-200 disabled:opacity-50"
              type="button"
              :disabled="!canGenerateDid"
              @click="generateDidFromResponse"
            >
              {{ didGenerating ? 'D-ID生成中…' : 'Caty応答からD-ID動画生成' }}
            </button>
          </div>

          <p v-if="didError" class="border border-red-400/40 rounded-xl bg-red-950/40 p-3 text-xs text-red-100 leading-5">
            {{ didError }}
          </p>

          <pre v-if="didResult" class="max-h-48 overflow-auto border border-slate-700 rounded-xl bg-slate-950 p-3 text-xs text-slate-300 leading-5">{{ JSON.stringify(didResult, null, 2) }}</pre>
        </div>

        <div class="overflow-hidden border border-slate-700 rounded-2xl bg-black/70">
          <video
            v-if="didVideoSrc"
            :key="didVideoKey"
            :src="didVideoSrc"
            class="aspect-square h-full min-h-52 w-full object-cover"
            controls
            playsinline
          />
          <div v-else class="grid min-h-52 place-items-center p-4 text-center text-sm text-slate-500">
            D-ID動画URLを入力してください
          </div>
        </div>
      </section>

      <div v-if="error" class="border border-red-400/40 rounded-2xl bg-red-950/40 p-4 text-red-100">
        {{ error }}
      </div>

      <div v-if="response" class="border border-emerald-300/30 rounded-2xl bg-emerald-950/20 p-4 space-y-3">
        <p class="text-sm text-emerald-200">
          Response
        </p>
        <p class="whitespace-pre-wrap text-lg leading-8">
          {{ response.text }}
        </p>
        <dl class="grid gap-2 text-sm text-slate-300 sm:grid-cols-3">
          <div>
            <dt class="text-slate-500">
              agent
            </dt><dd>{{ response.metadata?.agent || '-' }}</dd>
          </div>
          <div>
            <dt class="text-slate-500">
              emotion
            </dt><dd>{{ response.emotion || '-' }}</dd>
          </div>
          <div>
            <dt class="text-slate-500">
              latency
            </dt><dd>{{ response.metadata?.latency_ms ?? '-' }} ms</dd>
          </div>
        </dl>
      </div>

      <details v-if="rawResponse" class="border border-slate-800 rounded-2xl bg-slate-950/70 p-4">
        <summary class="cursor-pointer text-sm text-slate-400">
          Raw JSON
        </summary>
        <pre class="mt-3 overflow-auto text-xs text-slate-300">{{ rawResponse }}</pre>
      </details>
    </section>
  </main>
</template>
