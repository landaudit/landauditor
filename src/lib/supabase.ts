import { createClient } from '@supabase/supabase-js'

// =============================================
// Supabase Client
// =============================================

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env.local'
  )
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// =============================================
// Types — matches Supabase schema exactly
// =============================================

export interface Tenant {
  id: string
  agency_name: string
  email: string
  normalized_email: string
  primary_color: string
  agency_logo_url: string | null
  recipient_emails: string[]
  credits_balance: number
  created_at: string
  updated_at: string
}

export type SessionStatus =
  | 'uploading'
  | 'converting'
  | 'extracting'
  | 'compliance_check'
  | 'complete'
  | 'failed'
  | 'refunded'

export interface AuditSession {
  id: string
  tenant_id: string
  status: SessionStatus
  input_type: 'camera' | 'file'
  total_pages: number | null
  current_page: number
  credits_consumed: number | null
  full_text: string | null
  merged_result: MergedResult | null
  file_metadata: FileMetadata[]
  error_message: string | null
  created_at: string
  updated_at: string
}

export interface PageExtraction {
  entities: ExtractedEntity[]
  property_details: PropertyDetails
}

export interface ExtractedEntity {
  name: string
  role: string
  capacity: string
  page: number
  context: string
}

export interface PropertyDetails {
  deed_type: string
  land_size: string
  location: string
  expiry_date: string | null
  site_plan_ref: string
  marital_status_indicated: boolean
}

export interface MergedResult {
  entities: MergedEntity[]
  property_details: PropertyDetails
}

export interface MergedEntity {
  name: string
  roles: string[]
  capacity: string
  capacity_conflict: boolean
  requires_manual_review: boolean
  source_pages: number[]
  contexts: string[]
}

export interface ComplianceFlag {
  id: string
  session_id: string
  tenant_id: string
  section: string
  severity: 'missing_info' | 'legal_risk' | 'statutory_violation' | 'discrepancy'
  badge_color: 'yellow' | 'red'
  description: string
  cited_act_text: string | null
  page_references: number[]
  created_at: string
}

export interface ChatMessage {
  id: string
  session_id: string
  tenant_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

export interface Transaction {
  id: string
  tenant_id: string
  paystack_reference: string
  amount_ghs: number
  credits_purchased: number
  status: 'pending' | 'success' | 'failed'
  created_at: string
}

export interface FileMetadata {
  name: string
  type: string
  size: number
}

export interface CreditCheck {
  sufficient: boolean
  balance: number
  needed: number
}

// =============================================
// PDF Report Helper — generates base64 for email
// =============================================

export async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const result = reader.result as string
      resolve(result.split(',')[1]) // strip data:...;base64,
    }
    reader.readAsDataURL(blob)
  })
}