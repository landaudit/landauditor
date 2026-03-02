import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type FormEvent,
  type ReactNode,
  type ChangeEvent,
  type DragEvent,
} from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import ReactCrop, { type Crop, type PixelCrop } from 'react-image-crop'
import 'react-image-crop/dist/ReactCrop.css'
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  pdf,
} from '@react-pdf/renderer'
import { useAuth } from './App'
import {
  supabase,
  blobToBase64,
  type AuditSession,
  type ComplianceFlag,
  type MergedResult,
  type MergedEntity,
  type ChatMessage,
  type SessionStatus,
} from './lib/supabase'

// =============================================
// Shared Utilities
// =============================================

const VALID_FILE_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
])
const VALID_FILE_ACCEPT = '.pdf,.doc,.docx,.txt'
const MAX_FILE_SIZE = 20 * 1024 * 1024
const MAX_CAMERA_PAGES = 20

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

async function getCroppedBlob(
  image: HTMLImageElement,
  crop: PixelCrop
): Promise<Blob> {
  const scaleX = image.naturalWidth / image.width
  const scaleY = image.naturalHeight / image.height
  const sx = crop.x * scaleX
  const sy = crop.y * scaleY
  const sw = crop.width * scaleX
  const sh = crop.height * scaleY
  const maxDim = 2000
  const outputScale = Math.min(1, maxDim / Math.max(sw, sh))
  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(sw * outputScale)
  canvas.height = Math.floor(sh * outputScale)
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  return new Promise((r) => canvas.toBlob((b) => r(b!), 'image/jpeg', 0.85))
}

async function rotateImage90(src: string): Promise<string> {
  const img = await loadImage(src)
  const canvas = document.createElement('canvas')
  canvas.width = img.height
  canvas.height = img.width
  const ctx = canvas.getContext('2d')!
  ctx.translate(canvas.width / 2, canvas.height / 2)
  ctx.rotate(Math.PI / 2)
  ctx.drawImage(img, -img.width / 2, -img.height / 2)
  const blob = await new Promise<Blob>((r) =>
    canvas.toBlob((b) => r(b!), 'image/jpeg', 0.9)
  )
  return URL.createObjectURL(blob)
}

// =============================================
// Stepper Config
// =============================================

const STEPS: { key: SessionStatus; label: string; icon: string }[] = [
  { key: 'uploading', label: 'Uploading', icon: '📤' },
  { key: 'converting', label: 'Converting', icon: '🔄' },
  { key: 'extracting', label: 'Extracting', icon: '🔍' },
  { key: 'compliance_check', label: 'Compliance', icon: '⚖️' },
  { key: 'complete', label: 'Complete', icon: '✅' },
]

function getStepIndex(status: SessionStatus): number {
  if (status === 'failed' || status === 'refunded') return -1
  return STEPS.findIndex((s) => s.key === status)
}

// =============================================
// PDF Report Component
// =============================================

const pdfStyles = StyleSheet.create({
  page: { padding: 40, fontSize: 10, fontFamily: 'Helvetica', color: '#1e293b' },
  header: { marginBottom: 20 },
  title: { fontSize: 20, fontFamily: 'Helvetica-Bold', marginBottom: 4 },
  subtitle: { fontSize: 10, color: '#64748b', marginBottom: 20 },
  sectionTitle: { fontSize: 13, fontFamily: 'Helvetica-Bold', marginBottom: 8, marginTop: 16, color: '#0f172a' },
  row: { flexDirection: 'row', marginBottom: 4 },
  label: { width: 140, fontFamily: 'Helvetica-Bold', color: '#475569' },
  value: { flex: 1, color: '#1e293b' },
  entityCard: { marginBottom: 8, padding: 8, backgroundColor: '#f8fafc', borderRadius: 4 },
  entityName: { fontFamily: 'Helvetica-Bold', fontSize: 11, marginBottom: 2 },
  flagCard: { marginBottom: 8, padding: 8, borderRadius: 4 },
  flagRed: { backgroundColor: '#fef2f2', borderLeft: '3 solid #ef4444' },
  flagYellow: { backgroundColor: '#fffbeb', borderLeft: '3 solid #f59e0b' },
  flagSection: { fontFamily: 'Helvetica-Bold', fontSize: 10, marginBottom: 2 },
  flagDesc: { fontSize: 9, color: '#475569', marginBottom: 4 },
  flagCited: { fontSize: 8, color: '#64748b', fontStyle: 'italic', padding: 6, backgroundColor: '#ffffff', borderRadius: 3, marginTop: 4 },
  footer: { position: 'absolute', bottom: 30, left: 40, right: 40, fontSize: 8, color: '#94a3b8', textAlign: 'center' },
  note: { fontSize: 9, color: '#64748b', marginTop: 20, padding: 10, backgroundColor: '#f1f5f9', borderRadius: 4 },
})

function AuditReportPDF({
  merged,
  flags,
  agencyName,
  sessionId,
  totalPages,
  accentColor,
}: {
  merged: MergedResult
  flags: ComplianceFlag[]
  agencyName: string
  sessionId: string
  totalPages: number | null
  accentColor: string
}) {
  const p = merged.property_details

  return (
    <Document>
      <Page size="A4" style={pdfStyles.page}>
        {/* Header */}
        <View style={pdfStyles.header}>
          <Text style={[pdfStyles.title, { color: accentColor }]}>{agencyName}</Text>
          <Text style={pdfStyles.subtitle}>
            Land Audit Report — Session {sessionId.slice(0, 8)} — {new Date().toLocaleDateString('en-GB')}
          </Text>
        </View>

        {/* Property Details */}
        <Text style={pdfStyles.sectionTitle}>Property Details</Text>
        {([
          ['Deed Type', p.deed_type],
          ['Land Size', p.land_size],
          ['Location', p.location],
          ['Expiry Date', p.expiry_date],
          ['Site Plan Ref', p.site_plan_ref],
          ['Marital Status Indicated', p.marital_status_indicated ? 'Yes' : 'No'],
        ] as const).map(([label, val]) => (
          <View style={pdfStyles.row} key={label}>
            <Text style={pdfStyles.label}>{label}:</Text>
            <Text style={pdfStyles.value}>{val || 'Not found'}</Text>
          </View>
        ))}

        {/* Entities */}
        <Text style={pdfStyles.sectionTitle}>Extracted Entities</Text>
        {merged.entities.map((e, i) => (
          <View key={i} style={pdfStyles.entityCard}>
            <Text style={pdfStyles.entityName}>
              {e.name} {e.requires_manual_review ? '⚠' : ''}
            </Text>
            <Text>Role(s): {e.roles.join(', ')}</Text>
            <Text>Capacity: {e.capacity}{e.capacity_conflict ? ' (CONFLICT)' : ''}</Text>
            <Text style={{ fontSize: 8, color: '#94a3b8' }}>Pages: {e.source_pages.join(', ')}</Text>
          </View>
        ))}

        {/* Compliance Flags */}
        {flags.length > 0 && (
          <>
            <Text style={pdfStyles.sectionTitle}>Compliance Flags</Text>
            {flags.map((f, i) => (
              <View key={i} style={[pdfStyles.flagCard, f.badge_color === 'red' ? pdfStyles.flagRed : pdfStyles.flagYellow]}>
                <Text style={pdfStyles.flagSection}>
                  [{f.badge_color === 'red' ? 'RED' : 'YELLOW'}] {f.section}
                </Text>
                <Text style={pdfStyles.flagDesc}>{f.description}</Text>
                {f.cited_act_text && (
                  <Text style={pdfStyles.flagCited}>Act 1036: {f.cited_act_text}</Text>
                )}
                {f.page_references?.length > 0 && (
                  <Text style={{ fontSize: 8, color: '#94a3b8' }}>Ref pages: {f.page_references.join(', ')}</Text>
                )}
              </View>
            ))}
          </>
        )}

        <Text style={pdfStyles.note}>
          This report was generated automatically. Site plan visual verification must be performed manually.
          All data extracted verbatim from the source document. Compliance checks reference Ghana Land Act 2020 (Act 1036).
        </Text>

        <Text style={pdfStyles.footer}>
          {agencyName} — Land Audit Platform — {totalPages || 'N/A'} pages processed — Generated {new Date().toISOString()}
        </Text>
      </Page>
    </Document>
  )
}

// =============================================
// Layout
// =============================================

export function Layout({ children }: { children: ReactNode }) {
  const { tenant, signOut } = useAuth()
  const accent = tenant?.primary_color || '#1a56db'

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="md:hidden flex items-center justify-between bg-white border-b border-slate-200 px-4 py-3">
        <span className="font-bold text-sm truncate" style={{ color: accent }}>{tenant?.agency_name}</span>
        <div className="flex items-center gap-3">
          <span className="text-xs bg-slate-100 text-slate-700 font-medium px-2 py-1 rounded-md">{tenant?.credits_balance ?? 0} credits</span>
          <button onClick={signOut} className="text-xs text-slate-500 hover:text-slate-700">Sign out</button>
        </div>
      </header>
      <aside className="hidden md:flex md:flex-col w-64 bg-white border-r border-slate-200 fixed inset-y-0 left-0 z-40">
        <div className="p-6 border-b border-slate-200">
          {tenant?.agency_logo_url ? (
            <img src={tenant.agency_logo_url} alt={tenant.agency_name} className="h-10 object-contain" />
          ) : (
            <h1 className="text-lg font-bold truncate" style={{ color: accent }}>{tenant?.agency_name || 'Land Audit'}</h1>
          )}
        </div>
        <nav className="flex-1 p-4 space-y-1">
            <a
                href="/"
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-700 bg-slate-100"
            >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                </svg>
                Dashboard
            </a>
            <a
                href="/settings"
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-700 transition-colors"
            >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                Settings
            </a>
        </nav>
        <div className="p-4 border-t border-slate-200">
          <div className="rounded-lg bg-slate-50 p-4">
            <div className="text-xs text-slate-500 uppercase tracking-wider font-medium">Audit Credits</div>
            <div className="text-3xl font-bold text-slate-800 mt-1">{tenant?.credits_balance ?? 0}</div>
            <div className="text-xs text-slate-400 mt-1">1–10 pg = 1 credit</div>
          </div>
        </div>
        <div className="p-4 border-t border-slate-200">
          <button onClick={signOut} className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-100 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            Sign Out
          </button>
        </div>
      </aside>
      <main className="md:ml-64 p-4 md:p-8">{children}</main>
    </div>
  )
}

// =============================================
// Auth Page
// =============================================

export function AuthPage() {
  const { signIn, signUp } = useAuth()
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [agencyName, setAgencyName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault(); setError(null); setLoading(true)
    try {
      if (mode === 'signup') {
        if (!agencyName.trim()) { setError('Agency name is required.'); return }
        const res = await signUp(email.trim(), password, agencyName.trim())
        if (res.error) setError(res.error)
      } else {
        const res = await signIn(email.trim(), password)
        if (res.error) setError(res.error)
      }
    } finally { setLoading(false) }
  }

  const switchMode = () => { setMode((m) => (m === 'login' ? 'signup' : 'login')); setError(null) }

  return (
    <div className="min-h-screen flex">
      <div className="hidden lg:flex lg:w-1/2 bg-slate-900 items-center justify-center p-12">
        <div className="max-w-md">
          <h1 className="text-4xl font-bold text-white mb-4">Land Audit Platform</h1>
          <p className="text-slate-400 text-lg leading-relaxed">Process land deeds and indentures against the Ghana Land Act 2020 (Act 1036).</p>
          <div className="mt-10 grid grid-cols-2 gap-4">
            <div className="bg-slate-800 rounded-lg p-4"><div className="text-2xl font-bold text-white">Act 1036</div><div className="text-slate-400 text-sm mt-1">Compliance Engine</div></div>
            <div className="bg-slate-800 rounded-lg p-4"><div className="text-2xl font-bold text-white">5 Checks</div><div className="text-slate-400 text-sm mt-1">Red Flag Detection</div></div>
          </div>
        </div>
      </div>
      <div className="flex-1 flex items-center justify-center p-6 sm:p-8">
        <div className="w-full max-w-md">
          <div className="lg:hidden mb-8"><h1 className="text-2xl font-bold text-slate-800">Land Audit Platform</h1></div>
          <h2 className="text-2xl font-bold text-slate-800 mb-1">{mode === 'login' ? 'Welcome back' : 'Create your account'}</h2>
          <p className="text-slate-500 mb-8 text-sm">{mode === 'login' ? 'Sign in to access your dashboard.' : 'Start with 3 free audit credits.'}</p>
          {error && <div className="mb-6 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>}
          <form onSubmit={handleSubmit} className="space-y-5">
            {mode === 'signup' && (
              <div>
                <label htmlFor="agency" className="block text-sm font-medium text-slate-700 mb-1.5">Agency Name</label>
                <input id="agency" type="text" required value={agencyName} onChange={(e) => setAgencyName(e.target.value)} placeholder="e.g. Mensah & Associates"
                  className="w-full px-4 py-2.5 rounded-lg border border-slate-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder:text-slate-400" />
              </div>
            )}
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-slate-700 mb-1.5">Email</label>
              <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@agency.com"
                className="w-full px-4 py-2.5 rounded-lg border border-slate-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder:text-slate-400" />
            </div>
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-slate-700 mb-1.5">Password</label>
              <input id="password" type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Min. 6 characters"
                className="w-full px-4 py-2.5 rounded-lg border border-slate-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder:text-slate-400" />
            </div>
            <button type="submit" disabled={loading}
              className="w-full py-2.5 px-4 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
              {loading ? 'Please wait...' : mode === 'login' ? 'Sign In' : 'Create Account'}
            </button>
          </form>
          <p className="mt-8 text-center text-sm text-slate-500">
            {mode === 'login'
              ? <>Don&apos;t have an account?{' '}<button type="button" onClick={switchMode} className="text-blue-600 font-medium hover:underline">Sign up</button></>
              : <>Already have an account?{' '}<button type="button" onClick={switchMode} className="text-blue-600 font-medium hover:underline">Sign in</button></>}
          </p>
        </div>
      </div>
    </div>
  )
}

// =============================================
// Dashboard Page
// =============================================

const PRICING = [
  { credits: 1, price: 200, label: '1 Audit' },
  { credits: 5, price: 850, label: '5 Audits' },
  { credits: 20, price: 3_000, label: '20 Audits' },
] as const

export function DashboardPage() {
  const { tenant, refreshTenant } = useAuth()
  const navigate = useNavigate()
  const accent = tenant?.primary_color || '#1a56db'
  const [buying, setBuying] = useState<string | null>(null)

  const buyCredits = async (bundleKey: string) => {
    if (buying) return
    setBuying(bundleKey)
    try {
      const { data, error } = await supabase.functions.invoke('paystack-initialize', {
        body: { bundle_key: bundleKey },
      })
      if (error) throw new Error(error.message)
      if (data?.authorization_url) {
        window.location.href = data.authorization_url
      } else {
        throw new Error('No authorization URL received')
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Payment initialization failed')
      setBuying(null)
    }
  }

  return (
    <div className="max-w-5xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-800">Welcome, {tenant?.agency_name}</h1>
        <p className="text-slate-500 text-sm mt-1">Manage your land deed audits and compliance checks.</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <div className="text-sm text-slate-500">Credits Balance</div>
          <div className="text-3xl font-bold mt-1" style={{ color: accent }}>{tenant?.credits_balance ?? 0}</div>
          <div className="text-xs text-slate-400 mt-2 leading-relaxed">1–10 pages = 1 credit<br />11–20 pages = 2 credits</div>
        </div>
        {PRICING.map((b) => (
          <div key={b.credits} className="bg-white rounded-xl border border-slate-200 p-6 flex flex-col justify-between">
            <div>
              <div className="text-sm font-medium text-slate-800">{b.label}</div>
              <div className="text-2xl font-bold text-slate-800 mt-1">GHS {b.price.toLocaleString()}</div>
              <div className="text-xs text-slate-400 mt-1">
                GHS {Math.round(b.price / b.credits)} per audit
              </div>
            </div>
            <button
              className="mt-4 w-full py-2.5 px-4 rounded-lg text-white text-sm font-medium transition-colors hover:opacity-90 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              style={{ backgroundColor: accent }}
              disabled={buying !== null}
              onClick={() => buyCredits(String(b.credits))}
            >
              {buying === String(b.credits) ? (
                <><svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>Redirecting…</>
              ) : (
                <>Buy {b.credits} Credit{b.credits > 1 ? 's' : ''}</>
              )}
            </button>
          </div>
        ))}
      </div>
      <div className="bg-white rounded-xl border border-slate-200 p-10">
        <div className="text-center max-w-lg mx-auto">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-slate-100 mb-4">
            <svg className="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-slate-800 mb-2">Start a New Audit</h2>
          <p className="text-slate-500 text-sm mb-6 leading-relaxed">Upload a land deed or capture pages with your phone camera.</p>
          <button className="inline-flex items-center gap-2 py-3 px-8 rounded-lg text-white font-medium transition-colors hover:opacity-90 cursor-pointer"
            style={{ backgroundColor: accent }} onClick={() => navigate('/audit/new')}>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
            New Audit
          </button>
        </div>
      </div>
    </div>
  )
}

// =============================================
// New Audit Page
// =============================================

interface CapturedPage { id: string; url: string; blob: Blob }

export function NewAuditPage() {
  const { tenant } = useAuth()
  const navigate = useNavigate()
  const accent = tenant?.primary_color || '#1a56db'
  const [step, setStep] = useState<'choose' | 'camera' | 'file'>('choose')
  const [pages, setPages] = useState<CapturedPage[]>([])
  const [cropSrc, setCropSrc] = useState<string | null>(null)
  const [crop, setCrop] = useState<Crop>()
  const [completedCrop, setCompletedCrop] = useState<PixelCrop>()
  const imgRef = useRef<HTMLImageElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const openCamera = () => cameraInputRef.current?.click()
  const onImageCaptured = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return
    setCropSrc(URL.createObjectURL(f)); setCrop(undefined); setCompletedCrop(undefined); e.target.value = ''
  }
  const onCropImageLoad = useCallback(() => { setCrop({ unit: '%', x: 5, y: 5, width: 90, height: 90 }) }, [])
  const handleRotate = async () => {
    if (!cropSrc) return; const old = cropSrc; const n = await rotateImage90(cropSrc)
    URL.revokeObjectURL(old); setCropSrc(n); setCrop(undefined); setCompletedCrop(undefined)
  }
  const confirmCrop = async () => {
    if (!cropSrc) return
    let blob: Blob
    if (imgRef.current && completedCrop && completedCrop.width > 0 && completedCrop.height > 0) { blob = await getCroppedBlob(imgRef.current, completedCrop) }
    else { const res = await fetch(cropSrc); blob = await res.blob() }
    setPages((p) => [...p, { id: crypto.randomUUID(), url: URL.createObjectURL(blob), blob }])
    URL.revokeObjectURL(cropSrc); setCropSrc(null)
  }
  const cancelCrop = () => { if (cropSrc) URL.revokeObjectURL(cropSrc); setCropSrc(null) }
  const removePage = (id: string) => { setPages((p) => { const f = p.find((x) => x.id === id); if (f) URL.revokeObjectURL(f.url); return p.filter((x) => x.id !== id) }) }
  const onFileSelected = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return
    if (!VALID_FILE_TYPES.has(f.type)) { setError('Invalid file type.'); return }
    if (f.size > MAX_FILE_SIZE) { setError('File too large. Max 20 MB.'); return }
    setError(null); setFile(f)
  }
  const onDragOver = (e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setDragging(true) }
  const onDragLeave = () => setDragging(false)
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (!f) return
    if (!VALID_FILE_TYPES.has(f.type)) { setError('Invalid file type.'); return }
    if (f.size > MAX_FILE_SIZE) { setError('File too large. Max 20 MB.'); return }
    setError(null); setFile(f)
  }
  const goBack = () => {
    setStep('choose'); setError(null); setFile(null)
    pages.forEach((p) => URL.revokeObjectURL(p.url)); setPages([])
    if (cropSrc) URL.revokeObjectURL(cropSrc); setCropSrc(null)
  }
  const canStart = (step === 'camera' && pages.length > 0 && !cropSrc) || (step === 'file' && file !== null)
  const estimatedCredits = step === 'camera' ? (pages.length <= 10 ? 1 : 2) : '1–2'

  const startAudit = async () => {
    if (!canStart || uploading) return; setError(null); setUploading(true)
    try {
      const isCamera = step === 'camera'; const estPages = isCamera ? pages.length : 1
      const { data: check, error: rpcErr } = await supabase.rpc('check_credit_balance', { p_estimated_pages: estPages })
      if (rpcErr) throw new Error(rpcErr.message)
      if (!check.sufficient) { setError(`Insufficient credits. You have ${check.balance}, need ${check.needed}.`); return }
      const sessionId = crypto.randomUUID()
      const metadata = isCamera
        ? pages.map((p, i) => ({ name: `page_${i + 1}.jpg`, type: 'image/jpeg', size: p.blob.size }))
        : [{ name: file!.name, type: file!.type, size: file!.size }]
      const { error: insErr } = await supabase.from('audit_sessions').insert({
        id: sessionId, tenant_id: tenant!.id, status: 'uploading',
        input_type: isCamera ? 'camera' : 'file', total_pages: isCamera ? pages.length : null, file_metadata: metadata,
      })
      if (insErr) throw new Error(insErr.message)
      const base = `${tenant!.id}/${sessionId}`
      if (isCamera) {
        for (let i = 0; i < pages.length; i++) {
          const { error: upErr } = await supabase.storage.from('audit-uploads').upload(`${base}/page_${i + 1}.jpg`, pages[i].blob, { contentType: 'image/jpeg' })
          if (upErr) throw new Error(`Page ${i + 1} failed: ${upErr.message}`)
        }
      } else {
        const { error: upErr } = await supabase.storage.from('audit-uploads').upload(`${base}/${file!.name}`, file!, { contentType: file!.type })
        if (upErr) throw new Error(`Upload failed: ${upErr.message}`)
      }
      const { error: fnErr } = await supabase.functions.invoke('process-audit', { body: { session_id: sessionId } })
      if (fnErr) console.warn('Edge function warning:', fnErr.message)
      navigate(`/audit/${sessionId}`)
    } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Something went wrong') }
    finally { setUploading(false) }
  }

  const cropOverlay = cropSrc && (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      <div className="flex items-center justify-between p-4 bg-slate-900">
        <h3 className="text-white font-medium text-sm">Crop & Adjust</h3>
        <button onClick={handleRotate} className="text-white bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded-lg text-sm flex items-center gap-1.5 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
          Rotate
        </button>
      </div>
      <div className="flex-1 relative min-h-0">
        <ReactCrop crop={crop} onChange={(_, pc) => setCrop(pc)} onComplete={(c) => setCompletedCrop(c)} className="max-h-full">
          <img ref={imgRef} src={cropSrc} onLoad={onCropImageLoad} className="max-h-[calc(100vh-160px)] max-w-full mx-auto object-contain" alt="Crop preview" />
        </ReactCrop>
      </div>
      <div className="flex gap-3 p-4 bg-slate-900">
        <button onClick={cancelCrop} className="flex-1 py-2.5 rounded-lg border border-slate-600 text-slate-300 text-sm font-medium hover:bg-slate-800 transition-colors">Retake</button>
        <button onClick={confirmCrop} className="flex-1 py-2.5 rounded-lg text-white text-sm font-medium transition-colors" style={{ backgroundColor: accent }}>Confirm</button>
      </div>
    </div>
  )

  if (step === 'choose') {
    return (
      <div className="max-w-2xl">
        <button onClick={() => navigate('/')} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-6">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg> Back to Dashboard
        </button>
        <h1 className="text-2xl font-bold text-slate-800 mb-2">Start New Audit</h1>
        <p className="text-slate-500 text-sm mb-8">Choose how to add your document.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <button onClick={() => setStep('camera')} className="bg-white rounded-xl border-2 border-slate-200 p-8 text-left hover:border-blue-300 hover:shadow-sm transition-all group">
            <div className="w-12 h-12 rounded-lg bg-blue-50 flex items-center justify-center mb-4 group-hover:bg-blue-100 transition-colors">
              <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
            </div>
            <h3 className="text-lg font-semibold text-slate-800 mb-1">Camera Capture</h3>
            <p className="text-sm text-slate-500">Take photos of each page. Up to {MAX_CAMERA_PAGES} pages.</p>
          </button>
          <button onClick={() => setStep('file')} className="bg-white rounded-xl border-2 border-slate-200 p-8 text-left hover:border-blue-300 hover:shadow-sm transition-all group">
            <div className="w-12 h-12 rounded-lg bg-emerald-50 flex items-center justify-center mb-4 group-hover:bg-emerald-100 transition-colors">
              <svg className="w-6 h-6 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
            </div>
            <h3 className="text-lg font-semibold text-slate-800 mb-1">Upload File</h3>
            <p className="text-sm text-slate-500">Upload a single PDF, DOC, DOCX, or TXT. Max 20 MB.</p>
          </button>
        </div>
        <div className="mt-6 p-4 rounded-lg bg-slate-100 text-sm text-slate-500">
          <strong className="text-slate-700">Credit cost:</strong> 1 credit for 1–10 pages, 2 for 11–20.
          <span className="ml-2">Balance: <strong className="text-slate-700">{tenant?.credits_balance ?? 0}</strong></span>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-3xl">
      {cropOverlay}
      <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onImageCaptured} />
      <input ref={fileInputRef} type="file" accept={VALID_FILE_ACCEPT} className="hidden" onChange={onFileSelected} />
      <button onClick={goBack} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-6">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg> Back
      </button>
      {error && <div className="mb-6 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>}
      {step === 'camera' && (
        <>
          <div className="flex items-center justify-between mb-6">
            <div><h1 className="text-2xl font-bold text-slate-800">Camera Capture</h1><p className="text-slate-500 text-sm mt-1">{pages.length} of {MAX_CAMERA_PAGES} pages</p></div>
            {pages.length < MAX_CAMERA_PAGES && (
              <button onClick={openCamera} className="flex items-center gap-2 py-2 px-4 rounded-lg text-white text-sm font-medium hover:opacity-90" style={{ backgroundColor: accent }}>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg> Add Page
              </button>
            )}
          </div>
          {pages.length === 0 ? (
            <div onClick={openCamera} className="border-2 border-dashed border-slate-300 rounded-xl p-16 text-center cursor-pointer hover:border-blue-300 hover:bg-blue-50/50 transition-all">
              <svg className="w-12 h-12 text-slate-300 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
              <p className="text-slate-500 font-medium">Tap to capture first page</p>
            </div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3 mb-6">
              {pages.map((pg, i) => (
                <div key={pg.id} className="relative group">
                  <img src={pg.url} alt={`Page ${i + 1}`} className="w-full aspect-[3/4] object-cover rounded-lg border border-slate-200" />
                  <div className="absolute top-1 left-1 bg-black/60 text-white text-xs px-1.5 py-0.5 rounded">{i + 1}</div>
                  <button onClick={() => removePage(pg.id)} className="absolute top-1 right-1 bg-red-500 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600">×</button>
                </div>
              ))}
              {pages.length < MAX_CAMERA_PAGES && (
                <button onClick={openCamera} className="w-full aspect-[3/4] rounded-lg border-2 border-dashed border-slate-300 flex flex-col items-center justify-center text-slate-400 hover:border-blue-300 hover:text-blue-500 transition-colors">
                  <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg><span className="text-xs mt-1">Add</span>
                </button>
              )}
            </div>
          )}
        </>
      )}
      {step === 'file' && (
        <>
          <h1 className="text-2xl font-bold text-slate-800 mb-2">Upload Document</h1>
          <p className="text-slate-500 text-sm mb-6">Select a single PDF, DOC, DOCX, or TXT file.</p>
          <div onClick={() => fileInputRef.current?.click()} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
            className={`border-2 border-dashed rounded-xl p-16 text-center cursor-pointer transition-all ${dragging ? 'border-blue-400 bg-blue-50' : file ? 'border-emerald-300 bg-emerald-50/50' : 'border-slate-300 hover:border-blue-300 hover:bg-blue-50/50'}`}>
            {file ? (
              <><svg className="w-12 h-12 text-emerald-500 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                <p className="text-slate-800 font-medium">{file.name}</p><p className="text-slate-500 text-sm mt-1">{formatBytes(file.size)}</p><p className="text-blue-600 text-sm mt-3 hover:underline">Click to change</p></>
            ) : (
              <><svg className="w-12 h-12 text-slate-300 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
                <p className="text-slate-500 font-medium">{dragging ? 'Drop file here' : 'Drop file here or click to browse'}</p><p className="text-slate-400 text-sm mt-1">PDF, DOC, DOCX, TXT — Max 20 MB</p></>
            )}
          </div>
        </>
      )}
      <div className="mt-8 flex flex-col sm:flex-row items-center justify-between gap-4 p-4 bg-white rounded-xl border border-slate-200">
        <div className="text-sm text-slate-500">Est: <strong className="text-slate-700">{estimatedCredits} credit{estimatedCredits !== 1 ? 's' : ''}</strong> <span className="mx-2 text-slate-300">|</span> Balance: <strong className="text-slate-700">{tenant?.credits_balance ?? 0}</strong></div>
        <button onClick={startAudit} disabled={!canStart || uploading} className="w-full sm:w-auto py-2.5 px-8 rounded-lg text-white text-sm font-medium transition-colors hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed" style={{ backgroundColor: accent }}>
          {uploading ? <span className="flex items-center gap-2"><svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>Uploading…</span> : 'Start Audit'}
        </button>
      </div>
    </div>
  )
}

// =============================================
// Audit Page — Stepper + Results + Chat + PDF
// =============================================

export function AuditPage() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const { tenant, refreshTenant } = useAuth()
  const navigate = useNavigate()
  const accent = tenant?.primary_color || '#1a56db'

  const [session, setSession] = useState<AuditSession | null>(null)
  const [flags, setFlags] = useState<ComplianceFlag[]>([])
  const [loading, setLoading] = useState(true)

  // Chat state
  const [chatOpen, setChatOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const chatEndRef = useRef<HTMLDivElement>(null)

  // PDF/Email state
  const [pdfGenerating, setPdfGenerating] = useState(false)
  const [emailSending, setEmailSending] = useState(false)
  const [emailSent, setEmailSent] = useState(false)

    // Fetch session — ★ NO CHANGES, this is fine
    useEffect(() => {
        if (!sessionId) return
        const fetchSession = async () => {
            const { data } = await supabase.from('audit_sessions').select('*').eq('id', sessionId).single()
            if (data) {
                setSession(data as AuditSession)
                if (data.status === 'complete' || data.status === 'failed' || data.status === 'refunded') {
                    const { data: f } = await supabase.from('compliance_flags').select('*').eq('session_id', sessionId).order('created_at')
                    if (f) setFlags(f as ComplianceFlag[])
                    refreshTenant()
                }
            }
            setLoading(false)
        }
        fetchSession()
    }, [sessionId])

    // ★ CHANGED — Realtime: audit session updates
    // Don't trust payload.new for merged_result — do a full refetch on completion
    useEffect(() => {
        if (!sessionId) return
        const channel = supabase.channel(`audit-${sessionId}`)
            .on('postgres_changes',
                { event: 'UPDATE', schema: 'public', table: 'audit_sessions', filter: `id=eq.${sessionId}` },
                async (payload) => {
                    const u = payload.new as AuditSession

                    // For non-terminal statuses, use the payload directly (progress updates)
                    if (u.status !== 'complete' && u.status !== 'failed' && u.status !== 'refunded') {
                        setSession((prev) => prev ? { ...prev, ...u } : u)
                        return
                    }

                    // ★ For terminal statuses, do a FULL refetch to get merged_result
                    console.log(`[Realtime] Status changed to ${u.status}, fetching full session...`)
                    const { data: fullSession } = await supabase
                        .from('audit_sessions')
                        .select('*')
                        .eq('id', sessionId)
                        .single()

                    if (fullSession) {
                        setSession(fullSession as AuditSession)

                        const { data: f } = await supabase
                            .from('compliance_flags')
                            .select('*')
                            .eq('session_id', sessionId)
                            .order('created_at')
                        if (f) setFlags(f as ComplianceFlag[])

                        refreshTenant()
                    }
                }
            )
            .subscribe()
        return () => { supabase.removeChannel(channel) }
    }, [sessionId])

    // ★ CHANGED — Polling fallback: also does full refetch on terminal status
    useEffect(() => {
        if (!sessionId) return
        const isTerminal = session?.status === 'complete' || session?.status === 'failed' || session?.status === 'refunded'
        if (isTerminal) return

        const interval = setInterval(async () => {
            const { data } = await supabase
                .from('audit_sessions')
                .select('*')
                .eq('id', sessionId)
                .single()

            if (!data) return

            const status = data.status as SessionStatus

            if (status === 'complete' || status === 'failed' || status === 'refunded') {
                // ★ Terminal — set session with full data (includes merged_result)
                setSession(data as AuditSession)

                const { data: f } = await supabase
                    .from('compliance_flags')
                    .select('*')
                    .eq('session_id', sessionId)
                    .order('created_at')
                if (f) setFlags(f as ComplianceFlag[])

                refreshTenant()
                clearInterval(interval) // ★ Stop polling immediately
            } else {
                // ★ Still processing — update progress only
                setSession(data as AuditSession)
            }
        }, 3000)

        return () => clearInterval(interval)
    }, [sessionId, session?.status])

    // Load chat history
    useEffect(() => {
        if (!sessionId || !session || session.status !== 'complete') return
        supabase.from('chat_messages').select('*').eq('session_id', sessionId).order('created_at').then(({ data }) => {
            if (data) setMessages(data as ChatMessage[])
        })
    }, [sessionId, session?.status])

    // Realtime: chat messages
    useEffect(() => {
        if (!sessionId) return
        const channel = supabase.channel(`chat-${sessionId}`)
            .on('postgres_changes',
                { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `session_id=eq.${sessionId}` },
                (payload) => {
                    const msg = payload.new as ChatMessage
                    setMessages((prev) => {
                        if (prev.some((m) => m.id === msg.id)) return prev
                        const withoutTemp = prev.filter(
                            (m) => !(m.id.startsWith('temp-') && m.content === msg.content && m.role === msg.role)
                        )
                        return [...withoutTemp, msg]
                    })
                }
            )
            .subscribe()
        return () => { supabase.removeChannel(channel) }
    }, [sessionId])

    // Auto-scroll chat
    useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  // Send chat message
    const sendMessage = async () => {
        if (!chatInput.trim() || chatLoading || !sessionId || !session) return
        const msg = chatInput.trim()
        setChatInput('')
        setChatLoading(true)

        const userMsg: ChatMessage = {
            id: `temp-u-${Date.now()}`,
            session_id: sessionId,
            tenant_id: session.tenant_id,
            role: 'user',
            content: msg,
            created_at: new Date().toISOString(),
        }
        setMessages((prev) => [...prev, userMsg])

        try {
            const { data, error } = await supabase.functions.invoke('chat', {
                body: { session_id: sessionId, message: msg },
            })
            if (error) throw new Error(error.message)

            if (data?.reply) {
                const assistantMsg: ChatMessage = {
                    id: `temp-a-${Date.now()}`,
                    session_id: sessionId,
                    tenant_id: session.tenant_id,
                    role: 'assistant',
                    content: data.reply,
                    created_at: new Date().toISOString(),
                }
                setMessages((prev) => [...prev, assistantMsg])
            }
        } catch (err) {
            console.error('Chat error:', err)
            setMessages((prev) => prev.filter((m) => m.id !== userMsg.id))
        } finally {
            setChatLoading(false)
        }
    }

  // Download PDF
  const downloadPdf = async () => {
    if (!session || !session.merged_result) return; setPdfGenerating(true)
    try {
      const merged = session.merged_result as MergedResult
      const blob = await pdf(
        <AuditReportPDF merged={merged} flags={flags} agencyName={tenant?.agency_name || 'Agency'}
          sessionId={sessionId || ''} totalPages={session.total_pages} accentColor={accent} />
      ).toBlob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `audit-report-${sessionId?.slice(0, 8)}.pdf`
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url)
    } finally { setPdfGenerating(false) }
  }

  // Email PDF
  const emailPdf = async () => {
    if (!session || !session.merged_result || emailSending) return; setEmailSending(true)
    try {
      const merged = session.merged_result as MergedResult
      const blob = await pdf(
        <AuditReportPDF merged={merged} flags={flags} agencyName={tenant?.agency_name || 'Agency'}
          sessionId={sessionId || ''} totalPages={session.total_pages} accentColor={accent} />
      ).toBlob()
      const base64 = await blobToBase64(blob)
      const { error } = await supabase.functions.invoke('send-report', { body: { session_id: sessionId, pdf_base64: base64 } })
      if (error) throw new Error(error.message)
      setEmailSent(true)
    } catch (err) { alert(err instanceof Error ? err.message : 'Email failed') }
    finally { setEmailSending(false) }
  }

  if (loading) return <div className="flex items-center justify-center py-20"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-slate-700" /></div>
  if (!session) return <div className="max-w-2xl"><h1 className="text-2xl font-bold text-slate-800 mb-4">Session Not Found</h1><button onClick={() => navigate('/')} className="text-blue-600 hover:underline text-sm">Dashboard</button></div>

  const currentStep = getStepIndex(session.status)
  const isFailed = session.status === 'failed' || session.status === 'refunded'
  const isComplete = session.status === 'complete'
  const merged = session.merged_result as MergedResult | null

  return (
    <div className="max-w-4xl relative">
      <button onClick={() => navigate('/')} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-6">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg> Dashboard
      </button>

      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Audit Results</h1>
        {isComplete && (
          <div className="flex items-center gap-2">
            <button onClick={downloadPdf} disabled={pdfGenerating}
              className="flex items-center gap-1.5 py-2 px-4 rounded-lg border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
              {pdfGenerating ? 'Generating…' : 'Download PDF'}
            </button>
            <button onClick={emailPdf} disabled={emailSending || emailSent}
              className="flex items-center gap-1.5 py-2 px-4 rounded-lg text-white text-sm font-medium disabled:opacity-50 transition-colors hover:opacity-90"
              style={{ backgroundColor: accent }}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
              {emailSent ? '✓ Sent' : emailSending ? 'Sending…' : 'Email Report'}
            </button>
          </div>
        )}
      </div>

      {/* Stepper */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 mb-6">
        <div className="flex items-center justify-between">
          {STEPS.map((s, idx) => {
            const isActive = idx === currentStep; const isDone = idx < currentStep
            const color = isFailed ? '#ef4444' : accent
            return (
              <div key={s.key} className="flex-1 flex flex-col items-center relative">
                {idx > 0 && <div className="absolute top-4 -left-1/2 w-full h-0.5" style={{ backgroundColor: isDone ? color : '#e2e8f0' }} />}
                <div className={`relative z-10 w-8 h-8 rounded-full flex items-center justify-center text-sm ${isDone ? 'text-white' : isActive ? 'text-white' : 'bg-slate-100 text-slate-400'}`}
                  style={{ backgroundColor: isDone || isActive ? color : undefined }}>
                  {isDone ? '✓' : s.icon}
                </div>
                <span className={`text-xs mt-2 ${isActive ? 'font-semibold text-slate-800' : 'text-slate-400'}`}>{s.label}</span>
              </div>
            )
          })}
        </div>
        {!isComplete && !isFailed && session.total_pages && (
          <div className="mt-4 text-center text-sm text-slate-500">Processing page {session.current_page} of {session.total_pages}</div>
        )}
      </div>

      {/* Error */}
      {isFailed && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-6 mb-6">
          <h3 className="font-semibold text-red-800 mb-1">Audit Failed</h3>
          <p className="text-red-700 text-sm">{session.error_message || 'Unexpected error.'}</p>
          {session.status === 'refunded' && <p className="text-red-600 text-sm mt-2 font-medium">Credits refunded.</p>}
          <button onClick={() => navigate('/audit/new')} className="mt-4 py-2 px-4 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors">Try Again</button>
        </div>
      )}

      {/* Processing */}
      {!isComplete && !isFailed && (
        <div className="bg-white rounded-xl border border-slate-200 p-10 text-center">
          <div className="animate-spin rounded-full h-10 w-10 mx-auto mb-4" style={{ borderWidth: 3, borderColor: `${accent}33`, borderTopColor: accent, borderStyle: 'solid' }} />
          <p className="text-slate-600 font-medium">Processing your document…</p>
          <p className="text-slate-400 text-sm mt-2">This page updates automatically.</p>
        </div>
      )}

      {/* Results */}
      {isComplete && merged && (
        <>
          <div className="bg-white rounded-xl border border-slate-200 p-6 mb-6">
            <h2 className="text-lg font-semibold text-slate-800 mb-4">Property Details</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {([['Deed Type', merged.property_details.deed_type], ['Land Size', merged.property_details.land_size],
                ['Location', merged.property_details.location], ['Expiry Date', merged.property_details.expiry_date],
                ['Site Plan Ref', merged.property_details.site_plan_ref],
                ['Marital Status', merged.property_details.marital_status_indicated ? 'Yes' : 'No'],
              ] as const).map(([l, v]) => (
                <div key={l}><div className="text-xs text-slate-500 uppercase tracking-wider font-medium">{l}</div>
                  <div className={`text-sm mt-1 ${v ? 'text-slate-800 font-medium' : 'text-amber-600 italic'}`}>{v || 'Not found'}</div></div>
              ))}
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-6 mb-6">
            <h2 className="text-lg font-semibold text-slate-800 mb-4">Extracted Entities</h2>
            <div className="space-y-4">
              {merged.entities.map((e: MergedEntity, i: number) => (
                <div key={i} className={`p-4 rounded-lg border ${e.requires_manual_review ? 'border-amber-300 bg-amber-50/50' : 'border-slate-200'}`}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="font-semibold text-slate-800">{e.name}</div>
                      <div className="text-sm text-slate-500 mt-1">Role{e.roles.length > 1 ? 's' : ''}: <span className="font-medium text-slate-700">{e.roles.join(', ')}</span></div>
                      <div className="text-sm text-slate-500">Capacity: <span className="font-medium text-slate-700">{e.capacity}</span></div>
                      <div className="text-xs text-slate-400 mt-1">Pages: {e.source_pages.join(', ')}</div>
                    </div>
                    <div className="flex flex-col gap-1">
                      {e.requires_manual_review && <span className="px-2 py-1 text-xs rounded-full bg-amber-100 text-amber-700 font-medium whitespace-nowrap">⚠ Review</span>}
                      {e.capacity_conflict && <span className="px-2 py-1 text-xs rounded-full bg-red-100 text-red-700 font-medium whitespace-nowrap">Capacity Conflict</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {flags.length > 0 && (
            <div className="bg-white rounded-xl border border-slate-200 p-6 mb-6">
              <h2 className="text-lg font-semibold text-slate-800 mb-4">Compliance Flags</h2>
              <div className="space-y-3">
                {flags.map((f) => (
                  <div key={f.id} className={`p-4 rounded-lg border-l-4 ${f.badge_color === 'red' ? 'border-l-red-500 bg-red-50' : 'border-l-amber-500 bg-amber-50'}`}>
                    <div className="flex items-start gap-3">
                      <span className={`shrink-0 px-2 py-0.5 text-xs rounded-full font-semibold uppercase ${f.badge_color === 'red' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                        {f.severity === 'statutory_violation' ? 'VIOLATION' : f.severity === 'legal_risk' ? 'RISK' : f.severity === 'discrepancy' ? 'DISCREPANCY' : 'MISSING'}
                      </span>
                      <div className="flex-1">
                        <div className="font-medium text-slate-800 text-sm">{f.section}</div>
                        <div className="text-sm text-slate-600 mt-1">{f.description}</div>
                        {f.cited_act_text && (
                          <details className="mt-2"><summary className="text-xs text-blue-600 cursor-pointer hover:underline">View Act 1036 Reference</summary>
                            <div className="mt-2 p-3 bg-white rounded border border-slate-200 text-xs text-slate-600 leading-relaxed">{f.cited_act_text}</div></details>
                        )}
                        {f.page_references.length > 0 && <div className="text-xs text-slate-400 mt-2">Pages: {f.page_references.join(', ')}</div>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="bg-slate-100 rounded-xl p-4 text-center text-sm text-slate-500 mb-6">
            {session.credits_consumed} credit{session.credits_consumed !== 1 ? 's' : ''} consumed • {session.total_pages} page{session.total_pages !== 1 ? 's' : ''} processed
          </div>
        </>
      )}

      {/* ===== CHAT ===== */}
      {isComplete && (
        <>
          {/* Toggle button */}
          {!chatOpen && (
            <button onClick={() => setChatOpen(true)}
              className="fixed bottom-6 right-6 w-14 h-14 rounded-full shadow-lg flex items-center justify-center text-white z-40 hover:opacity-90 transition-opacity"
              style={{ backgroundColor: accent }}>
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
            </button>
          )}

          {/* Chat panel */}
          {chatOpen && (
            <div className="fixed bottom-6 right-6 w-[380px] max-w-[calc(100vw-2rem)] h-[500px] max-h-[calc(100vh-6rem)] bg-white rounded-2xl shadow-2xl border border-slate-200 flex flex-col z-40 overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200" style={{ backgroundColor: accent }}>
                <div className="flex items-center gap-2">
                  <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                  <span className="text-white font-medium text-sm">Ask about this audit</span>
                </div>
                <button onClick={() => setChatOpen(false)} className="text-white/80 hover:text-white"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg></button>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {messages.length === 0 && (
                  <div className="text-center text-slate-400 text-sm py-8">
                    <p className="font-medium text-slate-500 mb-1">Legal Assistant</p>
                    <p>Ask questions about the extracted data.</p>
                    <p className="text-xs mt-2">Page citations shown as [p. X]</p>
                  </div>
                )}
                {messages.map((m) => (
                  <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed
                      ${m.role === 'user' ? 'text-white rounded-br-md' : 'bg-slate-100 text-slate-800 rounded-bl-md'}`}
                      style={m.role === 'user' ? { backgroundColor: accent } : undefined}>
                      <div className="whitespace-pre-wrap">{m.content}</div>
                    </div>
                  </div>
                ))}
                {chatLoading && (
                  <div className="flex justify-start"><div className="bg-slate-100 rounded-2xl rounded-bl-md px-4 py-3"><div className="flex gap-1"><div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" /><div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }} /><div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }} /></div></div></div>
                )}
                <div ref={chatEndRef} />
              </div>

              {/* Input */}
              <div className="p-3 border-t border-slate-200">
                <div className="flex gap-2">
                  <input value={chatInput} onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() } }}
                    placeholder="Ask a question…" disabled={chatLoading}
                    className="flex-1 px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 placeholder:text-slate-400" />
                  <button onClick={sendMessage} disabled={chatLoading || !chatInput.trim()}
                    className="p-2.5 rounded-xl text-white disabled:opacity-50 transition-colors hover:opacity-90"
                    style={{ backgroundColor: accent }}>
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// =============================================
// Payment Callback Page
// =============================================

export function PaymentCallbackPage() {
  const { tenant, refreshTenant } = useAuth()
  const navigate = useNavigate()
  const accent = tenant?.primary_color || '#1a56db'

  const [status, setStatus] = useState<'verifying' | 'success' | 'failed'>('verifying')
  const [message, setMessage] = useState('')
  const verified = useRef(false)

  useEffect(() => {
    if (verified.current) return
    verified.current = true

    const params = new URLSearchParams(window.location.search)
    const reference = params.get('reference') || params.get('trxref')

    if (!reference) {
      setStatus('failed')
      setMessage('No payment reference found.')
      return
    }

    // Poll for transaction status (webhook may take a moment)
    const checkTransaction = async () => {
      let attempts = 0
      const maxAttempts = 10

      while (attempts < maxAttempts) {
        const { data: tx } = await supabase
          .from('transactions')
          .select('status, credits_purchased')
          .eq('paystack_reference', reference)
          .single()

        if (tx?.status === 'success') {
          setStatus('success')
          setMessage(`${tx.credits_purchased} credit${tx.credits_purchased > 1 ? 's' : ''} added to your account!`)
          await refreshTenant()
          return
        }

        if (tx?.status === 'failed') {
          setStatus('failed')
          setMessage('Payment was not successful. No credits were charged.')
          return
        }

        // Still pending — wait and retry
        attempts++
        await new Promise((r) => setTimeout(r, 2000))
      }

      // Timeout — webhook may be slow
      setStatus('failed')
      setMessage('Payment verification is taking longer than expected. Your credits will be added automatically once confirmed. Please check your dashboard.')
    }

    checkTransaction()
  }, [])

  return (
    <div className="max-w-lg mx-auto text-center">
      {status === 'verifying' && (
        <div className="bg-white rounded-xl border border-slate-200 p-10">
          <div className="animate-spin rounded-full h-10 w-10 mx-auto mb-4"
            style={{ borderWidth: 3, borderColor: `${accent}33`, borderTopColor: accent, borderStyle: 'solid' }} />
          <h2 className="text-lg font-semibold text-slate-800 mb-2">Verifying Payment…</h2>
          <p className="text-slate-500 text-sm">Please wait while we confirm your payment with Paystack.</p>
        </div>
      )}

      {status === 'success' && (
        <div className="bg-white rounded-xl border border-emerald-200 p-10">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-emerald-100 flex items-center justify-center">
            <svg className="w-8 h-8 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-slate-800 mb-2">Payment Successful!</h2>
          <p className="text-slate-600 text-sm mb-2">{message}</p>
          <p className="text-sm text-slate-500 mb-6">
            New balance: <strong className="text-slate-800" style={{ color: accent }}>{tenant?.credits_balance ?? 0} credits</strong>
          </p>
          <button onClick={() => navigate('/')}
            className="py-2.5 px-8 rounded-lg text-white text-sm font-medium transition-colors hover:opacity-90"
            style={{ backgroundColor: accent }}>
            Go to Dashboard
          </button>
        </div>
      )}

      {status === 'failed' && (
        <div className="bg-white rounded-xl border border-red-200 p-10">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-100 flex items-center justify-center">
            <svg className="w-8 h-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-slate-800 mb-2">Payment Issue</h2>
          <p className="text-slate-600 text-sm mb-6">{message}</p>
          <div className="flex gap-3 justify-center">
            <button onClick={() => navigate('/')}
              className="py-2.5 px-6 rounded-lg border border-slate-200 text-slate-700 text-sm font-medium hover:bg-slate-50 transition-colors">
              Dashboard
            </button>
            <button onClick={() => navigate('/')}
              className="py-2.5 px-6 rounded-lg text-white text-sm font-medium transition-colors hover:opacity-90"
              style={{ backgroundColor: accent }}>
              Try Again
            </button>
          </div>
        </div>
      )}
    </div>
  )
}


// =============================================
// Settings Page
// =============================================

export function SettingsPage() {
    const { tenant, refreshTenant } = useAuth()
    const accent = tenant?.primary_color || '#1a56db'

    const [agencyName, setAgencyName] = useState(tenant?.agency_name || '')
    const [primaryColor, setPrimaryColor] = useState(tenant?.primary_color || '#1a56db')
    const [emails, setEmails] = useState<string[]>(tenant?.recipient_emails || [])
    const [newEmail, setNewEmail] = useState('')

    const [saving, setSaving] = useState(false)
    const [saved, setSaved] = useState(false)
    const [logoUploading, setLogoUploading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const logoInputRef = useRef<HTMLInputElement>(null)

    // Sync state when tenant loads/refreshes
    useEffect(() => {
        if (tenant) {
            setAgencyName(tenant.agency_name)
            setPrimaryColor(tenant.primary_color)
            setEmails(tenant.recipient_emails || [])
        }
    }, [tenant])

    // Save settings
    const saveSettings = async () => {
        if (!tenant) return
        setSaving(true)
        setError(null)
        setSaved(false)

        const { error: updateErr } = await supabase
            .from('tenants')
            .update({
                agency_name: agencyName.trim(),
                primary_color: primaryColor,
                recipient_emails: emails,
            })
            .eq('id', tenant.id)

        if (updateErr) {
            setError(updateErr.message)
        } else {
            await refreshTenant()
            setSaved(true)
            setTimeout(() => setSaved(false), 3000)
        }
        setSaving(false)
    }

    // Upload logo
    const handleLogoUpload = async (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file || !tenant) return

        if (!file.type.startsWith('image/')) {
            setError('Please upload an image file (PNG, JPG, SVG)')
            return
        }

        if (file.size > 2 * 1024 * 1024) {
            setError('Logo must be under 2 MB')
            return
        }

        setLogoUploading(true)
        setError(null)

        try {
            const ext = file.name.split('.').pop() || 'png'
            const path = `${tenant.id}/logo.${ext}`

            // Delete old logo if exists
            await supabase.storage.from('logos').remove([path])

            // Upload new
            const { error: upErr } = await supabase.storage
                .from('logos')
                .upload(path, file, {
                    contentType: file.type,
                    upsert: true,
                })

            if (upErr) throw new Error(upErr.message)

            // Get public URL
            const { data: urlData } = supabase.storage
                .from('audit-uploads')
                .getPublicUrl(path)

            // Save URL to tenant
            const { error: updateErr } = await supabase
                .from('tenants')
                .update({ agency_logo_url: urlData.publicUrl })
                .eq('id', tenant.id)

            if (updateErr) throw new Error(updateErr.message)

            await refreshTenant()
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Upload failed')
        } finally {
            setLogoUploading(false)
            e.target.value = ''
        }
    }

    // Remove logo
    const removeLogo = async () => {
        if (!tenant) return
        setError(null)

        const { error: updateErr } = await supabase
            .from('tenants')
            .update({ agency_logo_url: null })
            .eq('id', tenant.id)

        if (!updateErr) await refreshTenant()
    }

    // Recipient emails
    const addEmail = () => {
        const trimmed = newEmail.trim().toLowerCase()
        if (!trimmed || !trimmed.includes('@')) return
        if (emails.length >= 10) {
            setError('Maximum 10 recipient emails')
            return
        }
        if (emails.includes(trimmed)) {
            setError('Email already added')
            return
        }
        setEmails([...emails, trimmed])
        setNewEmail('')
        setError(null)
    }

    const removeEmail = (idx: number) => {
        setEmails(emails.filter((_, i) => i !== idx))
    }

    return (
        <div className="max-w-2xl">
            <h1 className="text-2xl font-bold text-slate-800 mb-2">Settings</h1>
            <p className="text-slate-500 text-sm mb-8">
                Customize your agency branding and report delivery.
            </p>

            {error && (
                <div className="mb-6 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
                    {error}
                </div>
            )}

            {saved && (
                <div className="mb-6 p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm">
                    Settings saved successfully!
                </div>
            )}

            {/* Logo */}
            <div className="bg-white rounded-xl border border-slate-200 p-6 mb-6">
                <h2 className="text-lg font-semibold text-slate-800 mb-4">Agency Logo</h2>
                <div className="flex items-center gap-6">
                    <div className="w-20 h-20 rounded-xl border-2 border-dashed border-slate-300 flex items-center justify-center overflow-hidden bg-slate-50">
                        {tenant?.agency_logo_url ? (
                            <img
                                src={tenant.agency_logo_url}
                                alt="Logo"
                                className="w-full h-full object-contain p-1"
                            />
                        ) : (
                            <svg className="w-8 h-8 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                                    d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                            </svg>
                        )}
                    </div>
                    <div>
                        <input
                            ref={logoInputRef}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={handleLogoUpload}
                        />
                        <div className="flex gap-2">
                            <button
                                onClick={() => logoInputRef.current?.click()}
                                disabled={logoUploading}
                                className="py-2 px-4 rounded-lg border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-colors"
                            >
                                {logoUploading ? 'Uploading…' : tenant?.agency_logo_url ? 'Change Logo' : 'Upload Logo'}
                            </button>
                            {tenant?.agency_logo_url && (
                                <button
                                    onClick={removeLogo}
                                    className="py-2 px-4 rounded-lg border border-red-200 text-sm font-medium text-red-600 hover:bg-red-50 transition-colors"
                                >
                                    Remove
                                </button>
                            )}
                        </div>
                        <p className="text-xs text-slate-400 mt-2">
                            PNG, JPG, or SVG. Max 2 MB. Shows in sidebar and PDF reports.
                        </p>
                    </div>
                </div>
            </div>

            {/* Agency Name + Brand Color */}
            <div className="bg-white rounded-xl border border-slate-200 p-6 mb-6">
                <h2 className="text-lg font-semibold text-slate-800 mb-4">Branding</h2>

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1.5">
                            Agency Name
                        </label>
                        <input
                            type="text"
                            value={agencyName}
                            onChange={(e) => setAgencyName(e.target.value)}
                            className="w-full px-4 py-2.5 rounded-lg border border-slate-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1.5">
                            Brand Color
                        </label>
                        <div className="flex items-center gap-3">
                            <input
                                type="color"
                                value={primaryColor}
                                onChange={(e) => setPrimaryColor(e.target.value)}
                                className="w-10 h-10 rounded-lg border border-slate-300 cursor-pointer p-0.5"
                            />
                            <input
                                type="text"
                                value={primaryColor}
                                onChange={(e) => setPrimaryColor(e.target.value)}
                                className="w-32 px-4 py-2.5 rounded-lg border border-slate-300 bg-white text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                placeholder="#1a56db"
                            />
                            <div
                                className="h-10 flex-1 rounded-lg"
                                style={{ backgroundColor: primaryColor }}
                            />
                        </div>
                        <p className="text-xs text-slate-400 mt-1.5">
                            Used for buttons, accents, sidebar, and PDF reports.
                        </p>
                    </div>
                </div>
            </div>

            {/* Recipient Emails */}
            <div className="bg-white rounded-xl border border-slate-200 p-6 mb-6">
                <h2 className="text-lg font-semibold text-slate-800 mb-1">Report Recipients</h2>
                <p className="text-slate-500 text-sm mb-4">
                    PDF reports will be sent to your login email plus these addresses.
                </p>

                <div className="flex gap-2 mb-4">
                    <input
                        type="email"
                        value={newEmail}
                        onChange={(e) => setNewEmail(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addEmail() } }}
                        placeholder="colleague@agency.com"
                        className="flex-1 px-4 py-2.5 rounded-lg border border-slate-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder:text-slate-400"
                    />
                    <button
                        onClick={addEmail}
                        disabled={emails.length >= 10}
                        className="py-2.5 px-4 rounded-lg text-white text-sm font-medium disabled:opacity-50 transition-colors hover:opacity-90"
                        style={{ backgroundColor: accent }}
                    >
                        Add
                    </button>
                </div>

                {emails.length > 0 ? (
                    <div className="space-y-2">
                        {emails.map((email, idx) => (
                            <div
                                key={idx}
                                className="flex items-center justify-between px-4 py-2.5 bg-slate-50 rounded-lg"
                            >
                                <span className="text-sm text-slate-700">{email}</span>
                                <button
                                    onClick={() => removeEmail(idx)}
                                    className="text-slate-400 hover:text-red-500 transition-colors"
                                >
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                </button>
                            </div>
                        ))}
                    </div>
                ) : (
                    <p className="text-sm text-slate-400 italic">
                        No additional recipients. Reports will only go to your login email.
                    </p>
                )}

                <p className="text-xs text-slate-400 mt-3">
                    {emails.length}/10 recipient emails
                </p>
            </div>

            {/* Save Button */}
            <button
                onClick={saveSettings}
                disabled={saving || !agencyName.trim()}
                className="w-full py-3 px-4 rounded-lg text-white text-sm font-medium transition-colors hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ backgroundColor: accent }}
            >
                {saving ? 'Saving…' : 'Save Settings'}
            </button>
        </div>
    )
}

