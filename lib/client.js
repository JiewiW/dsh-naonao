window.__ModuleLoader__.load({
  id: 'dsh-naonao',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    // ---------- 常量 ----------
    var RPC_CHANNEL = '/naonao'
    var BTN_LABEL = '唠叨'
    var STORE_KEY = 'dsh-naonao-open:v1'
    var DOCK_RESET_PROPS = [
      'background',
      'border',
      'borderRadius',
      'boxShadow',
      'backdropFilter'
    ]
    // 候选对话区选择器，按优先级尝试
    var CHAT_FLOW_SELECTORS = [
      '[data-chat-flow]',
      '[data-slot="conversation.chat"]',
      '.dsh-chat-flow',
      '.chat-flow'
    ]

    // ---------- RPC ----------
    var rpcIdCounter = 0
    function rpcCall(method, payload) {
      var rpcId = 'naonao-' + String(++rpcIdCounter)
      var body = JSON.stringify({
        type: 'client-request',
        rpcId: rpcId,
        method: method,
        params: payload || {}
      })
      return fetch(RPC_CHANNEL + '/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.json()
      }).then(function (envelope) {
        if (envelope.type === 'error') throw new Error(envelope.error || 'RPC 调用失败')
        return envelope.result
      })
    }

    // ---------- 工具函数 ----------
    // 当前会话 id：兼容两代内核。
    // 旧内核 sessions.list 快照带 current 字段；0.2.0-rc.2 内核的 projectList()
    // 只 set {ids, byId, phase, projectionsBySession}，已无 current —— 此时退化为
    // 按内核自身语义取 retainedBy.mainView > 0（该会话正被主视图持有/显示）的条目。
    function getCurrentSessionId(sessions) {
      if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== 'function') return null
      var snap = sessions.list.getSnapshot()
      if (!snap) return null
      if (snap.current) return snap.current
      var byId = snap.byId
      if (!byId) return null
      var ids = Object.keys(byId)
      for (var i = 0; i < ids.length; i += 1) {
        var row = byId[ids[i]]
        if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) return row.id || ids[i]
      }
      return null
    }

    function readOpenState() {
      try {
        return window.localStorage.getItem(STORE_KEY) === 'true'
      } catch (e) {
        return false
      }
    }

    function writeOpenState(open) {
      try {
        window.localStorage.setItem(STORE_KEY, open ? 'true' : 'false')
      } catch (e) { /* noop */ }
    }

    /**
     * 估算 token 数（粗估：中文按 1.5 字/token，英文按 4 字符/token）。
     * @param {string} text
     * @returns {number}
     */
    function estimateTokens(text) {
      if (!text) return 0
      var chineseCount = (text.match(/[\u4e00-\u9fa5]/g) || []).length
      var otherChars = text.length - chineseCount
      return Math.round(chineseCount / 1.5 + otherChars / 4)
    }

    /**
     * 唠叨长度评级 + 影响说明。
     * @param {number} tokens - 估算 token 数。
     * @returns {{level: string, color: string, desc: string}}
     */
    function rateNaonao(tokens) {
      if (tokens === 0) {
        return { level: '无', color: '#6b7280', desc: '未开启，无额外消耗' }
      }
      if (tokens <= 30) {
        return { level: '轻量', color: '#10b981', desc: '约占 1% 上下文，几乎不影响' }
      }
      if (tokens <= 100) {
        return { level: '适中', color: '#f59e0b', desc: '约占 2-3% 上下文，影响可控' }
      }
      if (tokens <= 300) {
        return { level: '较重', color: '#ef4444', desc: '约占 5-10% 上下文，可能稀释注意力' }
      }
      return { level: '过重', color: '#dc2626', desc: '超过 10% 上下文，建议精简' }
    }

    function resetDockStyles(el) {
      var oldStyles = {}
      DOCK_RESET_PROPS.forEach(function (prop) {
        oldStyles[prop] = el.style.getPropertyValue(prop)
        el.style.setProperty(prop, 'initial', 'important')
      })
      return oldStyles
    }

    function restoreDockStyles(el, oldStyles) {
      if (!el || !oldStyles) return
      DOCK_RESET_PROPS.forEach(function (prop) {
        if (oldStyles[prop] !== undefined && oldStyles[prop] !== '') {
          el.style.setProperty(prop, oldStyles[prop], 'important')
        } else {
          el.style.removeProperty(prop)
        }
      })
    }

    /**
     * 找到对话区元素：在所有候选匹配中选「最宽」的那个（真正的对话文本列必然是宽容器，
     * 而 querySelector 只取第一个可能命中侧栏/折叠区的窄元素）。
     * @returns {HTMLElement|null}
     */
    function findChatFlow() {
      // 能否取到元素可见性，排除隐藏/零宽元素
      function visibleWidth(el) {
        return el.getBoundingClientRect().width
      }
      var best = null
      var bestWidth = 0
      var checked = 0
      var i
      for (i = 0; i < CHAT_FLOW_SELECTORS.length; i++) {
        var matches = document.querySelectorAll(CHAT_FLOW_SELECTORS[i])
        for (var j = 0; j < matches.length; j++) {
          checked++
          var w = visibleWidth(matches[j])
          if (w > 200 && w > bestWidth) { // 忽略过窄/隐藏容器
            bestWidth = w
            best = matches[j]
          }
        }
      }
      if (best) return best
      // 兜底：找消息气泡所在的最近滚动容器
      var bubbles = document.querySelectorAll('[data-role="assistant"], [data-role="user"]')
      if (bubbles.length > 0) {
        var el2 = bubbles[0]
        while (el2 && el2.parentElement) {
          var parent = el2.parentElement
          if (parent.scrollHeight > parent.clientHeight + 50) {
            return parent
          }
          el2 = parent
        }
      }
      return null
    }

    /**
     * 找卡片真正的布局包含块。
     * 插槽直接父元素可能是 display:contents（不生成盒子，rect 全 0），
     * 必须跳过，向上找到第一个有真实宽度的祖先元素。
     * @param {HTMLElement} card
     * @returns {HTMLElement|null}
     */
    function findContainingBlock(card) {
      var el = card.parentElement
      var depth = 0
      while (el && depth < 6) {
        var rect = el.getBoundingClientRect()
        if (rect.width > 0) return el
        el = el.parentElement
        depth++
      }
      return null
    }

    // ---------- NaonaoCard 组件 ----------
    function NaonaoCard(props) {
      var sessions = props.sessions
      var isOpen = props.isOpen

      var _a = React.useState('')
      var draftText = _a[0]
      var setDraftText = _a[1]

      var _b = React.useState('')
      var savedText = _b[0]
      var setSavedText = _b[1]

      var _c = React.useState(false)
      var saving = _c[0]
      var setSaving = _c[1]

      var cardRef = React.useRef(null)
      var dockContainerRef = React.useRef(null)
      var oldStylesRef = React.useRef(null)
      var rafIdRef = React.useRef(null)
      var resizeObserverRef = React.useRef(null)

      // 加载已保存文本
      React.useEffect(function () {
        if (!isOpen) return
        var sessionId = getCurrentSessionId(sessions)
        if (!sessionId) return
        rpcCall('get', { sessionId: sessionId }).then(function (result) {
          if (result && typeof result.text === 'string') {
            setSavedText(result.text)
            setDraftText(result.text)
          }
        }).catch(function (err) {
          console.warn('[naonao] 读取失败:', err)
        })
      }, [isOpen, sessions])

      // 布局调整：底纹修复 + 宽度锚定对话区 + 跟随变化
      React.useEffect(function () {
        if (!isOpen) return
        if (!cardRef.current) return

        var chatFlowEl = null
        var oldDockStyles = null
        var chatFlowObserver = null
        var dockParentObserver = null
        var retryTimer = null
        var rafId = null
        var lastWidth = 0
        var lastLeft = 0

        function adjustLayout() {
          if (!cardRef.current) return
          var card = cardRef.current

          // 定位基准：跳过 display:contents 的插槽父元素，找真正生成盒子的包含块
          var containingBlockEl = findContainingBlock(card)
          if (!containingBlockEl) return

          // 压掉强制底纹，并监听包含块尺寸变化
          if (!oldDockStyles) {
            oldDockStyles = resetDockStyles(containingBlockEl)
          }
          if (!dockParentObserver && window.ResizeObserver) {
            dockParentObserver = new ResizeObserver(function () {
              scheduleAdjust()
            })
            dockParentObserver.observe(containingBlockEl)
          }

          // 找对话区元素（第一次或之前没找到时重试）
          if (!chatFlowEl) {
            chatFlowEl = findChatFlow()
            if (chatFlowEl && window.ResizeObserver) {
              chatFlowObserver = new ResizeObserver(function () {
                scheduleAdjust()
              })
              chatFlowObserver.observe(chatFlowEl)
            }
          }

          // 卡片跟对话区左对齐、等宽
          if (chatFlowEl) {
            var flowRect = chatFlowEl.getBoundingClientRect()
            var blockRect = containingBlockEl.getBoundingClientRect()
            var targetWidth = flowRect.width
            var offsetX = flowRect.left - blockRect.left

            if (Math.abs(targetWidth - lastWidth) > 1 || Math.abs(offsetX - lastLeft) > 1) {
              card.style.width = targetWidth + 'px'
              card.style.maxWidth = targetWidth + 'px'
              card.style.marginLeft = offsetX + 'px'
              card.style.marginRight = '0'
              card.style.transform = 'none'
              lastWidth = targetWidth
              lastLeft = offsetX
            }
          }
        }

        function scheduleAdjust() {
          if (rafId) cancelAnimationFrame(rafId)
          rafId = requestAnimationFrame(adjustLayout)
        }

        // 首次 + 重试（元素可能还没渲染完）
        adjustLayout()
        var retries = 0
        retryTimer = setInterval(function () {
          retries++
          adjustLayout()
          if (chatFlowEl && retries >= 3) clearInterval(retryTimer)
          if (retries >= 10) clearInterval(retryTimer)
        }, 200)

        window.addEventListener('resize', scheduleAdjust)

        var bodyObserver = new MutationObserver(function () {
          scheduleAdjust()
        })
        bodyObserver.observe(document.body, {
          attributes: true,
          attributeFilter: ['class', 'style'],
          subtree: true,
          childList: false
        })

        return function () {
          clearInterval(retryTimer)
          window.removeEventListener('resize', scheduleAdjust)
          if (rafId) cancelAnimationFrame(rafId)
          if (chatFlowObserver) chatFlowObserver.disconnect()
          if (dockParentObserver) dockParentObserver.disconnect()
          if (bodyObserver) bodyObserver.disconnect()
          if (cardRef.current && oldDockStyles) {
            var blockOnCleanup = findContainingBlock(cardRef.current)
            if (blockOnCleanup) restoreDockStyles(blockOnCleanup, oldDockStyles)
          }
        }
      }, [isOpen])

      function handleSave() {
        var sessionId = getCurrentSessionId(sessions)
        if (!sessionId) return
        setSaving(true)
        rpcCall('set', { sessionId: sessionId, text: draftText }).then(function (result) {
          if (result && typeof result.text === 'string') {
            setSavedText(result.text)
          }
        }).catch(function (err) {
          console.warn('[naonao] 保存失败:', err)
        }).finally(function () {
          setSaving(false)
        })
      }

      function handleClear() {
        var sessionId = getCurrentSessionId(sessions)
        if (!sessionId) return
        setDraftText('')
        rpcCall('clear', { sessionId: sessionId }).then(function () {
          setSavedText('')
        }).catch(function (err) {
          console.warn('[naonao] 清除失败:', err)
        })
      }

      if (!isOpen) {
        return React.createElement('div', { style: { display: 'none' } })
      }

      var savedTokens = estimateTokens(savedText)
      var rating = rateNaonao(savedTokens)

      // 卡片主体：顶部说明 + 编辑区/已保存双栏
      return React.createElement(
        'div',
        {
          ref: cardRef,
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            padding: '12px 16px',
            boxSizing: 'border-box',
            width: '100%'
          }
        },
        // 顶部说明：动态评级一行 + 固定说明一行
        React.createElement(
          'div',
          {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '2px'
            }
          },
          React.createElement(
            'div',
            {
              style: {
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '12px'
              }
            },
            React.createElement(
              'div',
              { style: { display: 'flex', gap: '8px', flexShrink: 0 } },
              React.createElement(
                'button',
                {
                  onClick: handleSave,
                  disabled: saving,
                  style: {
                    padding: '4px 14px',
                    fontSize: '12px',
                    borderRadius: '6px',
                    border: 'none',
                    background: 'var(--dsw-brand-default, #6c5ce7)',
                    color: '#fff',
                    cursor: saving ? 'not-allowed' : 'pointer',
                    opacity: saving ? 0.6 : 1
                  }
                },
                saving ? '保存中…' : '保存'
              ),
              React.createElement(
                'button',
                {
                  onClick: handleClear,
                  style: {
                    padding: '4px 12px',
                    fontSize: '12px',
                    borderRadius: '6px',
                    border: '1px solid var(--dsw-border-default, rgba(255,255,255,0.1))',
                    background: 'transparent',
                    color: 'var(--dsw-text-secondary, #9ca3af)',
                    cursor: 'pointer'
                  }
                },
                '清除'
              )
            ),
            React.createElement(
              'div',
              {
                style: {
                  flex: 1,
                  minWidth: 0,
                  fontSize: '12px',
                  color: rating.color,
                  fontWeight: 600,
                  textAlign: 'right'
                }
              },
              savedText
                ? rating.level + ' · 约 ' + savedTokens + ' tokens · ' + rating.desc
                : '未开启，无额外消耗'
            )
          ),
          React.createElement(
            'div',
            {
              style: {
                fontSize: '11px',
                color: 'var(--dsw-text-tertiary, #6b7280)',
                textAlign: 'right'
              }
            },
            '保存后挂在运行时上下文末尾；同会话中其他上下文（如记忆快照）变化时，本内容会随合并快照搭车重发，临时需求用完请点「清除」。'
          )
        ),
        React.createElement(
          'div',
          {
            style: {
              display: 'flex',
              gap: '12px',
              height: '160px',
              boxSizing: 'border-box',
              width: '100%'
            }
          },
        // 左栏：编辑区
        React.createElement(
          'div',
          {
            style: {
              flex: '1 1 0',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              minWidth: 0
            }
          },
          React.createElement(
            'div',
            {
              style: {
                fontSize: '13px',
                fontWeight: 600,
                color: 'var(--dsw-text-primary, #e9ecf2)'
              }
            },
            '编辑唠叨内容'
          ),
          React.createElement('textarea', {
            value: draftText,
            onChange: function (e) { setDraftText(e.target.value) },
            placeholder: '在这里输入你想反复提醒模型的话…\n点击"保存"后，每轮对话末尾都会注入。',
            style: {
              flex: 1,
              resize: 'none',
              padding: '8px 10px',
              fontSize: '13px',
              lineHeight: '1.5',
              color: 'var(--dsw-text-primary, #e9ecf2)',
              background: 'var(--dsw-bg-layer-2, rgba(255,255,255,0.06))',
              border: '1px solid var(--dsw-border-default, rgba(255,255,255,0.1))',
              borderRadius: '8px',
              outline: 'none',
              fontFamily: 'inherit'
            }
          })
        ),
        // 中栏：已保存内容
        React.createElement(
          'div',
          {
            style: {
              flex: '1 1 0',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              minWidth: 0
            }
          },
          React.createElement(
            'div',
            {
              style: {
                fontSize: '13px',
                fontWeight: 600,
                color: 'var(--dsw-text-primary, #e9ecf2)'
              }
            },
            '当前已保存（每轮注入）'
          ),
          React.createElement(
            'div',
            {
              style: {
                flex: 1,
                padding: '8px 10px',
                fontSize: '13px',
                lineHeight: '1.5',
                color: savedText
                  ? 'var(--dsw-text-primary, #e9ecf2)'
                  : 'var(--dsw-text-tertiary, #6b7280)',
                background: 'var(--dsw-bg-layer-2, rgba(255,255,255,0.06))',
                border: '1px solid var(--dsw-border-default, rgba(255,255,255,0.1))',
                borderRadius: '8px',
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word'
              }
            },
            savedText || '（还没有保存唠叨内容）\n保存后，你写的文字会在每轮对话末尾注入给模型。'
          )
        )
      )
      )
    }

    // ---------- NaonaoButton 组件 ----------
    function NaonaoButton(props) {
      var isActive = props.isActive
      var onClick = props.onClick
      return React.createElement(
        'button',
        {
          onClick: onClick,
          title: '唠叨模式：每轮对话末尾注入你写的提醒文字',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            padding: '4px 10px',
            fontSize: '12px',
            borderRadius: '6px',
            border: 'none',
            background: isActive
              ? 'var(--dsw-bg-layer-2, rgba(255,255,255,0.1))'
              : 'transparent',
            color: 'var(--dsw-text-secondary, #9ca3af)',
            cursor: 'pointer',
            whiteSpace: 'nowrap'
          }
        },
        '💬 ',
        BTN_LABEL
      )
    }

    // ---------- 插件入口 ----------
    var name = 'dsh-naonao'
    var inject = ['slots', 'sessions']

    function apply(ctx) {
      var slots = ctx.slots
      var sessions = ctx.sessions

      var openState = { current: readOpenState() }
      var listeners = []

      function setOpen(open) {
        openState.current = open
        writeOpenState(open)
        listeners.forEach(function (fn) {
          try { fn(open) } catch (e) {}
        })
      }

      function toggleOpen() {
        setOpen(!openState.current)
      }

      function subscribe(fn) {
        listeners.push(fn)
        return function () {
          var idx = listeners.indexOf(fn)
          if (idx >= 0) listeners.splice(idx, 1)
        }
      }

      // dock 卡片
      ctx.effect(function () {
        return slots.inject('conversation.input.dock', function () {
          return slots.register(
            {
              name: 'conversation.input.dock',
              id: 'dsh-naonao-card',
              order: 50
            },
            function () {
              var _a = React.useState(openState.current)
              var isOpen = _a[0]
              var setIsOpen = _a[1]
              React.useEffect(function () {
                return subscribe(function (open) { setIsOpen(open) })
              }, [])
              return React.createElement(NaonaoCard, {
                sessions: sessions,
                isOpen: isOpen
              })
            }
          )
        })
      }, 'naonao dock card')

      // 左下角按钮
      ctx.effect(function () {
        return slots.inject('conversation.input.left', function () {
          return slots.register(
            {
              name: 'conversation.input.left',
              id: 'dsh-naonao-button',
              order: 30
            },
            function () {
              var _a = React.useState(openState.current)
              var isOpen = _a[0]
              var setIsOpen = _a[1]
              React.useEffect(function () {
                return subscribe(function (open) { setIsOpen(open) })
              }, [])
              return React.createElement(NaonaoButton, {
                isActive: isOpen,
                onClick: toggleOpen
              })
            }
          )
        })
      }, 'naonao toggle button')
    }

    var plugin = {
      name: name,
      inject: inject,
      apply: apply
    }

    exports.apply = apply
    exports.default = plugin
    exports.inject = inject
    exports.name = name
    return module.exports
  }
})
