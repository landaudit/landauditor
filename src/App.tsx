import {
    createContext,
    useContext,
    useEffect,
    useState,
    useRef,
    type ReactNode,
} from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import type { User, Session } from '@supabase/supabase-js'
import { supabase, type Tenant } from './lib/supabase'
import { Layout, AuthPage, DashboardPage, NewAuditPage, AuditPage, PaymentCallbackPage, SettingsPage } from './pages'

// =============================================
// Auth Context
// =============================================

interface AuthState {
    user: User | null
    tenant: Tenant | null
    session: Session | null
    loading: boolean
}

interface AuthContextType extends AuthState {
    signUp: (email: string, password: string, agencyName: string) => Promise<{ error: string | null }>
    signIn: (email: string, password: string) => Promise<{ error: string | null }>
    signOut: () => Promise<void>
    refreshTenant: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function useAuth() {
    const ctx = useContext(AuthContext)
    if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
    return ctx
}

async function fetchTenant(userId: string): Promise<Tenant | null> {
    console.log('fetchTenant called with:', userId)
    const { data, error } = await supabase
        .from('tenants')
        .select('*')
        .eq('id', userId)
        .single()

    console.log('fetchTenant result:', { data, error })

    if (error) {
        console.error('Tenant fetch failed:', error.message)
        return null
    }
    return data as Tenant
}

function AuthProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState<AuthState>({
        user: null,
        tenant: null,
        session: null,
        loading: true,
    })
    const signingUp = useRef(false)

    // ── Effect 1: Auth bootstrap ──────────────────────────────────
    // Sets user / session ONLY.  Never calls supabase.from() here
    // because onAuthStateChange fires while getSession() holds the
    // internal auth lock — any PostgREST call would deadlock.
    useEffect(() => {
        let mounted = true

        console.log('AuthProvider: checking session...')

        supabase.auth
            .getSession()
            .then(({ data: { session } }) => {
                console.log(
                    'AuthProvider: getSession result:',
                    session ? 'has session' : 'no session'
                )
                if (!mounted) return
                if (session?.user) {
                    // Just store user + session; tenant effect below handles the rest
                    setState((prev) => ({
                        ...prev,
                        user: session.user,
                        session,
                        // loading stays true until the tenant is fetched
                    }))
                } else {
                    setState({ user: null, tenant: null, session: null, loading: false })
                }
            })
            .catch((err) => {
                console.error('AuthProvider: getSession error:', err)
                if (mounted) {
                    setState({ user: null, tenant: null, session: null, loading: false })
                }
            })

        const {
            data: { subscription },
        } = supabase.auth.onAuthStateChange((event, session) => {
            console.log('AuthProvider: onAuthStateChange', event)
            if (!mounted || signingUp.current) return

            if (event === 'SIGNED_OUT') {
                setState({ user: null, tenant: null, session: null, loading: false })
                return
            }

            if (session?.user) {
                // Only touch user + session — NO supabase.from() calls here!
                setState((prev) => {
                    const userChanged = prev.user?.id !== session.user.id
                    return {
                        ...prev,
                        user: session.user,
                        session,
                        // If a different user signed in, clear tenant so Effect 2 refetches
                        ...(userChanged ? { tenant: null, loading: true } : {}),
                    }
                })
            }
        })

        return () => {
            mounted = false
            subscription.unsubscribe()
        }
    }, [])

    // ── Effect 2: Fetch tenant row ────────────────────────────────
    // Triggers whenever we have a user but no tenant yet.
    // Runs OUTSIDE the auth lock so the PostgREST query resolves.
    useEffect(() => {
        const userId = state.user?.id
        // Nothing to do if: no user, already have tenant, or not in loading state
        if (!userId || state.tenant || !state.loading) return

        let cancelled = false
        console.log('AuthProvider: fetching tenant for', userId)

        fetchTenant(userId)
            .then((tenant) => {
                console.log('AuthProvider: tenant fetched:', tenant ? 'found' : 'null')
                if (!cancelled) {
                    setState((prev) => ({ ...prev, tenant, loading: false }))
                }
            })
            .catch((err) => {
                console.error('AuthProvider: tenant fetch error:', err)
                if (!cancelled) {
                    setState((prev) => ({ ...prev, loading: false }))
                }
            })

        return () => {
            cancelled = true
        }
    }, [state.user?.id, state.tenant, state.loading])

    // ── Auth methods ──────────────────────────────────────────────

    const signUp = async (
        email: string,
        password: string,
        agencyName: string
    ): Promise<{ error: string | null }> => {
        signingUp.current = true
        try {
            const { data: authData, error: authError } =
                await supabase.auth.signUp({
                    email,
                    password,
                    options: { data: { agency_name: agencyName } },
                })
            if (authError) return { error: authError.message }
            if (
                !authData.user ||
                !authData.session ||
                authData.user.identities?.length === 0
            ) {
                return { error: 'An account with this email already exists.' }
            }
            const { error: tenantError } = await supabase
                .from('tenants')
                .insert({ id: authData.user.id, agency_name: agencyName, email })
            if (tenantError) {
                if (tenantError.code === '23505') {
                    return { error: 'An account with this email already exists.' }
                }
                return { error: tenantError.message }
            }
            const tenant = await fetchTenant(authData.user.id)
            setState({
                user: authData.user,
                tenant,
                session: authData.session,
                loading: false,
            })
            return { error: null }
        } finally {
            signingUp.current = false
        }
    }

    const signIn = async (
        email: string,
        password: string
    ): Promise<{ error: string | null }> => {
        const { error } = await supabase.auth.signInWithPassword({
            email,
            password,
        })
        if (error) return { error: error.message }
        return { error: null }
    }

    const signOut = async () => {
        await supabase.auth.signOut()
        setState({
            user: null,
            tenant: null,
            session: null,
            loading: false,
        })
    }

    const refreshTenant = async () => {
        if (!state.user) return
        const tenant = await fetchTenant(state.user.id)
        setState((p) => ({ ...p, tenant }))
    }

    return (
        <AuthContext.Provider
            value={{ ...state, signUp, signIn, signOut, refreshTenant }}
        >
            {children}
        </AuthContext.Provider>
    )
}

// =============================================
// Route Guards
// =============================================

function LoadingScreen() {
    return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-slate-700" />
        </div>
    )
}

function ProtectedRoute({ children }: { children: ReactNode }) {
    const { user, loading } = useAuth()
    if (loading) return <LoadingScreen />
    if (!user) return <Navigate to="/auth" replace />
    return <Layout>{children}</Layout>
}

function PublicRoute({ children }: { children: ReactNode }) {
    const { user, loading } = useAuth()
    if (loading) return <LoadingScreen />
    if (user) return <Navigate to="/" replace />
    return <>{children}</>
}

// =============================================
// App Root
// =============================================

export default function App() {
    return (
        <BrowserRouter basename={import.meta.env.BASE_URL}>
            <AuthProvider>
                <Routes>
                    <Route path="/auth" element={<PublicRoute><AuthPage /></PublicRoute>} />
                    <Route path="/" element={<ProtectedRoute><DashboardPage /></ProtectedRoute>} />
                    <Route path="/audit/new" element={<ProtectedRoute><NewAuditPage /></ProtectedRoute>} />
                    <Route path="/audit/:sessionId" element={<ProtectedRoute><AuditPage /></ProtectedRoute>} />
                    <Route path="/payment/callback" element={<ProtectedRoute><PaymentCallbackPage /></ProtectedRoute>} />
                    <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
            </AuthProvider>
        </BrowserRouter>
    )
}