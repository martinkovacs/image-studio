import { useEffect } from 'react'
import { Aperture, MessageSquare, Settings2, SlidersHorizontal, X } from 'lucide-react'
import { useStore } from './store'
import { cx, IconButton } from './components/ui'
import { StudioView } from './studio/StudioView'
import { ChatView } from './chat/ChatView'
import { SettingsView } from './settings/SettingsView'

export function App() {
  const settings = useStore((s) => s.settings)
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const updateSettings = useStore((s) => s.updateSettings)
  const toast = useStore((s) => s.toast)
  const init = useStore((s) => s.init)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    if (!settings) return
    const light =
      settings.theme === 'light' ||
      (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches)
    document.documentElement.classList.toggle('light', light)
  }, [settings?.theme])

  if (!settings) return <div className="h-full bg-ink-950" />

  const mode = settings.uiMode
  return (
    <div className="flex h-full">
      <nav className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-ink-800 bg-ink-950 py-3">
        <div className="mb-3 flex h-8 w-8 items-center justify-center text-safelight" title="Image Studio">
          <Aperture size={22} strokeWidth={1.6} />
        </div>
        <IconButton
          title="Studio"
          active={view === 'main' && mode === 'studio'}
          onClick={() => {
            setView('main')
            if (mode !== 'studio') void updateSettings({ uiMode: 'studio' })
          }}
        >
          <SlidersHorizontal size={17} />
        </IconButton>
        <IconButton
          title="Chat"
          active={view === 'main' && mode === 'chat'}
          onClick={() => {
            setView('main')
            if (mode !== 'chat') void updateSettings({ uiMode: 'chat' })
          }}
        >
          <MessageSquare size={17} />
        </IconButton>
        <div className="flex-1" />
        <IconButton title="Settings" active={view === 'settings'} onClick={() => setView(view === 'settings' ? 'main' : 'settings')}>
          <Settings2 size={17} />
        </IconButton>
      </nav>

      <main className="min-w-0 flex-1">
        {view === 'settings' ? <SettingsView /> : mode === 'chat' ? <ChatView /> : <StudioView />}
      </main>

      {toast && (
        <div
          className={cx(
            'rise fixed bottom-5 left-1/2 z-50 flex max-w-xl -translate-x-1/2 items-start gap-3 rounded-lg border px-4 py-3 text-[13px] shadow-2xl',
            toast.kind === 'error' ? 'border-stop/40 bg-ink-900 text-ink-100' : 'border-ink-700 bg-ink-900 text-ink-100'
          )}
        >
          <span className={cx('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', toast.kind === 'error' ? 'bg-stop' : 'bg-fixer')} />
          <span className="select-text whitespace-pre-wrap">{toast.text}</span>
          <button onClick={() => useStore.setState({ toast: null })} className="text-ink-400 hover:text-ink-100">
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
