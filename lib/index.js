/**
 * dsh-naonao — 唠叨模式 Host 端
 *
 * 功能：
 * 1. 按会话存储用户输入的"唠叨"文本（内存 Map，重启丢失但会话内持久）
 * 2. 通过 systemPrompt.context 动态注入到每轮模型上下文末尾
 * 3. 提供 RPC 端点供 Client 端读写：naonao/get、naonao/set、naonao/clear
 *
 * 缓存友好设计：文本为空时不注入，不破坏前缀缓存；
 * 文本走 context（user-role 快照追加在历史尾部），不改动 system prompt 主体。
 */

import { readFile } from 'node:fs/promises'

// ---------- 常量 ----------
/** RPC 通道前缀 */
const RPC_CHANNEL = '/naonao'
/** 上下文段落名（唯一标识，重复注册会抛错） */
const CONTEXT_NAME = 'dsh:naonao'
/** 上下文排序值（尾部，recency 最强） */
const CONTEXT_ORDER = 100000
/** 请求体上限（300KB，足够长文本） */
const MAX_BODY_BYTES = 307200
const JSON_MIME = 'application/json'
const SEGMENT = /^[A-Za-z0-9_$.-]+$/

// ---------- 存储 ----------
/** 按 sessionId 存唠叨文本 */
const naonaoTextMap = new Map()

/**
 * 获取指定会话的唠叨文本
 * @param {string} sessionId - 会话 ID
 * @returns {string} 唠叨文本，无则返回空串
 */
function getNaonaoText(sessionId) {
  return naonaoTextMap.get(sessionId) || ''
}

/**
 * 设置指定会话的唠叨文本
 * @param {string} sessionId - 会话 ID
 * @param {string} text - 唠叨文本
 */
function setNaonaoText(sessionId, text) {
  naonaoTextMap.set(sessionId, text)
}

/**
 * 清除指定会话的唠叨文本
 * @param {string} sessionId - 会话 ID
 */
function clearNaonaoText(sessionId) {
  naonaoTextMap.delete(sessionId)
}

// ---------- RPC 通道 ----------
/**
 * 判断请求是否为 JSON content-type
 */
function isJsonContentType(req) {
  const ct = req.headers['content-type'] || ''
  return ct.split(';')[0].trim().toLowerCase() === JSON_MIME
}

/**
 * 读取请求体
 */
async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

/**
 * 回复 JSON-RPC 响应
 */
function reply(res, rpcId, payload) {
  const body = JSON.stringify({ rpcId, ...payload })
  res.writeHead(200, {
    'Content-Type': JSON_MIME,
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

/**
 * 回复 404
 */
function missing(res) {
  res.writeHead(404)
  res.end('not found')
}

/**
 * 处理一次 HTTP RPC 请求
 */
async function serve(connection, channel, handler, req, res) {
  const rejection = connection.requestRejection(req)
  if (rejection !== undefined) {
    res.writeHead(rejection)
    res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
    return
  }
  if (req.method !== 'POST') return missing(res)
  const pathname = new URL(req.url || '/', 'http://localhost').pathname
  const prefix = `${channel}/`
  if (!pathname.startsWith(prefix)) return missing(res)
  const endpoint = pathname.slice(prefix.length)
  if (!endpoint.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && SEGMENT.test(part))) {
    return missing(res)
  }
  if (!isJsonContentType(req)) {
    res.writeHead(415)
    res.end('unsupported media type')
    return
  }
  let raw
  try {
    raw = await readBody(req)
  } catch (error) {
    res.writeHead(400)
    res.end('body read failed')
    return
  }
  let message
  try {
    message = JSON.parse(raw)
  } catch (error) {
    res.writeHead(400)
    res.end('body is not JSON')
    return
  }
  const rpcId = typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request'
  if (message.type !== 'client-request' || typeof message.method !== 'string') {
    reply(res, rpcId, { type: 'error', error: 'bad request' })
    return
  }
  try {
    const result = await handler(endpoint, message.params || {}, message)
    reply(res, rpcId, { type: 'response', result })
  } catch (error) {
    reply(res, rpcId, { type: 'error', error: error.message || String(error) })
  }
}

/**
 * 挂载 RPC 通道到 webServer
 */
function mountRpcChannel(ctx, channel, handler) {
  ctx.inject(['connection', 'webServer'], (scope) => {
    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'prefix',
          path: channel,
          handler: (req, res) => serve(scope.connection, channel, handler, req, res)
        }),
      `${channel}: rpc channel`
    )
  })
}

// ---------- RPC 处理器 ----------
/**
 * RPC 端点处理
 * @param {string} endpoint - 端点名（get/set/clear）
 * @param {object} params - 参数
 * @param {object} message - 完整请求消息
 */
async function handleRpc(endpoint, params, message) {
  const sessionId = params.sessionId
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('sessionId is required')
  }
  switch (endpoint) {
    case 'get':
      return { text: getNaonaoText(sessionId) }
    case 'set': {
      const text = typeof params.text === 'string' ? params.text : ''
      setNaonaoText(sessionId, text)
      return { ok: true, text }
    }
    case 'clear':
      clearNaonaoText(sessionId)
      return { ok: true }
    default:
      throw new Error(`unknown endpoint: ${endpoint}`)
  }
}

// ---------- 插件入口 ----------
export function apply(ctx) {
  // 1. 注册动态上下文注入（user-role 快照，追加在历史尾部）
  ctx.inject(['systemPrompt'], (scope) => {
    scope.effect(
      () =>
        scope.systemPrompt.context({
          name: CONTEXT_NAME,
          order: CONTEXT_ORDER,
          text: (context) => {
            const agent = context && context.agent
            if (!agent || !agent.session) return ''
            const sessionId = agent.session.id
            const text = getNaonaoText(sessionId)
            if (!text) return ''
            // 用醒目的分隔标题包裹，方便模型识别
            return `---

## 用户唠叨（本轮必须遵守）

${text}

---`
          }
        }),
      'naonao system-prompt context'
    )
  })

  // 2. 挂载 RPC 通道
  mountRpcChannel(ctx, RPC_CHANNEL, handleRpc)

  // 3. 会话清理：会话销毁时清理内存（全局监听，未 scope-filtered 时也能收到）
  ctx.on('session/disposed', (session) => {
    clearNaonaoText(session.id)
  })
}

export const inject = ['systemPrompt']

export default { apply, inject }
