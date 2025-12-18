// 拦截特定的 Pixiv API 请求，获取返回的数据并发送到内容脚本进行过滤
const apiList = [
  'ajax/search/top/',
  'ajax/search/illustrations/',
  'ajax/search/manga/',
  'ajax/search/novels/',
]

const needIntercept = (url) => {
  return apiList.some(api => url.includes(api))
}

// 控制是否生效（是否转发请求到内容脚本）
// 如果设置为不生效，则不进行转发，直接放行
// 有两种情况会设置为不生效：
// 1. 用户在设置里关闭了搜索结果过滤功能
// 2. 内容脚本在经过预期时间之后还未就绪，则使此功能失效，以避免无限等待
let enable = true

setTimeout(() => {
  if (!ready) {
    console.log('Content Script 等待超时，所以禁用了 API 拦截器')
    enable = false
  }
}, 1500)

// 内容脚本是否就绪
// 这个脚本会被尽早注入，此时内容脚本还未执行，所以需要等待内容脚本就绪
let ready = false

async function checkReady () {
  if (!ready) {
    await new Promise((resolve) => {
      const interval = setInterval(() => {
        if (ready) {
          clearInterval(interval)
          resolve()
        }
      }, 20)
    })
  }
}

// 用来存储每个请求的回调函数，通过唯一ID关联
const pendingRequests = new Map()

// console.time('ready')
// 监听来自 Content Script 的响应
window.addEventListener('message', (event) => {
  // 确保消息来自 Content Script，而不是其他来源（例如Pixiv页面本身）
  if (event.source === window && event.data.source === 'pixiv-downloader-content-script') {
    ready = true
    // console.log('Content Script 已就绪')
    // console.timeEnd('ready')
    // 等待 ready 的时间波动比较大，即使在同一网络条件下刷新页面（并且启用缓存），显示的时间也会从 100 ms 到 1000 ms 波动

    // 接收启用/禁用状态
    if (event.data?.setEnable !== undefined) {
      enable = event.data.setEnable
      console.log('API 拦截器功能状态：', enable ? '启用' : '禁用')
      return
    }

    // 接收过滤后的数据
    const { requestId, filteredData } = event.data
    if (pendingRequests.has(requestId)) {
      // 找到对应的请求，并用返回的数据 resolve Promise
      const { resolve } = pendingRequests.get(requestId)
      resolve(filteredData)
      // 完成后从 Map 中移除
      pendingRequests.delete(requestId)
    }
  }
})

/**
 * 将数据发送到 Content Script 进行过滤，并返回一个 Promise
 * @param {string} url - API 的完整 URL
 * @param {object} dataToFilter - 从 API 获取的原始作品数据
 * @returns {Promise<object>} - 一个解析为过滤后数据的 Promise
 */
function sendDataToContentScriptForFiltering (url, dataToFilter) {
  return new Promise((resolve, reject) => {
    // 为每个请求生成一个唯一 ID
    const requestId = `req-${Date.now()}-${Math.random()}`

    // 存储 resolve 和 reject 函数，等待响应
    pendingRequests.set(requestId, { resolve, reject })

    // 发送消息到 Content Script
    window.postMessage({
      source: 'pixiv-downloader-inject-script',
      url: url,
      requestId: requestId,
      dataToFilter: dataToFilter
    }, window.location.origin)

    // 设置一个超时，以防 Content Script 没有响应而导致页面卡死
    window.setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        reject(new Error(`请求 ${requestId} 超时`))
        pendingRequests.delete(requestId)
      }
    }, 5000) // 设置 5 秒超时
    // 当需要检查图片颜色时，花费的时间会比较长。一页 60 个作品的话，检查完它们的缩略图可能需要 3 秒种左右
  })
}

// 保存原始的 fetch 函数
const originalFetch = window.fetch

// 重写全局 fetch 函数
window.fetch = async function (...args) {
  const [url] = args

  // 检查是否需要拦截这个 URL
  if (enable && typeof url === 'string' && needIntercept(url)) {
    // console.log('拦截到目标 API:', url)
    const response = await originalFetch(...args)
    const clonedResponse = response.clone()

    // 只能读取一次响应体，所以克隆后先获取JSON
    const data = await clonedResponse.json()

    try {
      // 调用函数将数据发送到 Content Script 并等待过滤结果
      await checkReady()
      const filteredData = await sendDataToContentScriptForFiltering(url, data)

      // 使用过滤后的数据创建新的响应对象，并返回给页面原始的调用者
      return new Response(JSON.stringify(filteredData), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      })
    } catch (error) {
      // console.error('过滤数据时出错:', error)
      // 如果过滤失败，返回原始响应，以保证页面功能不会完全瘫痪
      return response
    }
  } else {
    // 如果未启用拦截器，或者 URL 不是目标 API，则正常执行原始的 fetch
    return originalFetch(...args)
  }
}
