export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      assignments: {
        Row: {
          assigned_by: string | null
          created_at: string
          id: string
          member_id: string
          staff_id: string | null
          type: Database["public"]["Enums"]["assign_type"]
        }
        Insert: {
          assigned_by?: string | null
          created_at?: string
          id: string
          member_id: string
          staff_id?: string | null
          type?: Database["public"]["Enums"]["assign_type"]
        }
        Update: {
          assigned_by?: string | null
          created_at?: string
          id?: string
          member_id?: string
          staff_id?: string | null
          type?: Database["public"]["Enums"]["assign_type"]
        }
        Relationships: [
          {
            foreignKeyName: "assignments_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      bets: {
        Row: {
          id: string
          issuer: string | null
          member_ref: string | null
          numbers: number[]
          prize: number | null
          rank: number | null
          round_no: number
        }
        Insert: {
          id: string
          issuer?: string | null
          member_ref?: string | null
          numbers: number[]
          prize?: number | null
          rank?: number | null
          round_no: number
        }
        Update: {
          id?: string
          issuer?: string | null
          member_ref?: string | null
          numbers?: number[]
          prize?: number | null
          rank?: number | null
          round_no?: number
        }
        Relationships: [
          {
            foreignKeyName: "bets_round_no_fkey"
            columns: ["round_no"]
            isOneToOne: false
            referencedRelation: "lotto_rounds"
            referencedColumns: ["round_no"]
          },
        ]
      }
      daily_work_count: {
        Row: {
          day: string
          head_count: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          day: string
          head_count?: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          day?: string
          head_count?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "daily_work_count_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          author_id: string | null
          body: string
          created_at: string
          ends_at: string | null
          id: string
          published: boolean
          starts_at: string | null
          title: string
          updated_at: string
          view_count: number
        }
        Insert: {
          author_id?: string | null
          body?: string
          created_at?: string
          ends_at?: string | null
          id: string
          published?: boolean
          starts_at?: string | null
          title: string
          updated_at?: string
          view_count?: number
        }
        Update: {
          author_id?: string | null
          body?: string
          created_at?: string
          ends_at?: string | null
          id?: string
          published?: boolean
          starts_at?: string | null
          title?: string
          updated_at?: string
          view_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "events_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      faqs: {
        Row: {
          answer: string
          category: string
          id: string
          published: boolean
          question: string
          sort_order: number
        }
        Insert: {
          answer?: string
          category?: string
          id: string
          published?: boolean
          question: string
          sort_order?: number
        }
        Update: {
          answer?: string
          category?: string
          id?: string
          published?: boolean
          question?: string
          sort_order?: number
        }
        Relationships: []
      }
      inquiries: {
        Row: {
          answer: string | null
          answered_at: string | null
          answered_by: string | null
          author_name: string
          body: string
          category: string
          created_at: string
          id: string
          member_id: string | null
          status: Database["public"]["Enums"]["inquiry_status"]
          title: string
        }
        Insert: {
          answer?: string | null
          answered_at?: string | null
          answered_by?: string | null
          author_name?: string
          body?: string
          category?: string
          created_at?: string
          id: string
          member_id?: string | null
          status?: Database["public"]["Enums"]["inquiry_status"]
          title: string
        }
        Update: {
          answer?: string | null
          answered_at?: string | null
          answered_by?: string | null
          author_name?: string
          body?: string
          category?: string
          created_at?: string
          id?: string
          member_id?: string | null
          status?: Database["public"]["Enums"]["inquiry_status"]
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "inquiries_answered_by_fkey"
            columns: ["answered_by"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inquiries_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      logs: {
        Row: {
          action: string
          actor: string | null
          created_at: string
          id: string
          kind: Database["public"]["Enums"]["log_kind"]
          meta: Json
          target_id: string | null
          target_type: string | null
        }
        Insert: {
          action: string
          actor?: string | null
          created_at?: string
          id: string
          kind: Database["public"]["Enums"]["log_kind"]
          meta?: Json
          target_id?: string | null
          target_type?: string | null
        }
        Update: {
          action?: string
          actor?: string | null
          created_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["log_kind"]
          meta?: Json
          target_id?: string | null
          target_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "logs_actor_fkey"
            columns: ["actor"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      lotto_rounds: {
        Row: {
          appear_rate: number | null
          bonus: number
          confirmed_at: string | null
          draw_date: string
          numbers: number[]
          odd_even: string
          prize_1: number | null
          prize_2: number | null
          prize_3: number | null
          round_no: number
          sum: number
          total_sales: number | null
        }
        Insert: {
          appear_rate?: number | null
          bonus: number
          confirmed_at?: string | null
          draw_date: string
          numbers: number[]
          odd_even?: string
          prize_1?: number | null
          prize_2?: number | null
          prize_3?: number | null
          round_no: number
          sum?: number
          total_sales?: number | null
        }
        Update: {
          appear_rate?: number | null
          bonus?: number
          confirmed_at?: string | null
          draw_date?: string
          numbers?: number[]
          odd_even?: string
          prize_1?: number | null
          prize_2?: number | null
          prize_3?: number | null
          round_no?: number
          sum?: number
          total_sales?: number | null
        }
        Relationships: []
      }
      members: {
        Row: {
          assigned_staff_id: string | null
          consult_status: string | null
          grade: Database["public"]["Enums"]["grade"]
          id: string
          inflow_code: string | null
          inflow_type: string | null
          is_deleted: boolean
          is_suspended: boolean
          is_withdrawn: boolean
          last_active_at: string | null
          memo: string | null
          meta: Json
          name: string
          nickname: string | null
          outcall_done: boolean
          phone: string
          registered_at: string
          status: Database["public"]["Enums"]["member_status"]
          team_id: string | null
          tendency: string | null
          user_id: string
          win_history: string | null
          member_operating_site: string | null
        }
        Insert: {
          assigned_staff_id?: string | null
          consult_status?: string | null
          grade?: Database["public"]["Enums"]["grade"]
          id: string
          inflow_code?: string | null
          inflow_type?: string | null
          is_deleted?: boolean
          is_suspended?: boolean
          is_withdrawn?: boolean
          last_active_at?: string | null
          memo?: string | null
          meta?: Json
          name: string
          nickname?: string | null
          outcall_done?: boolean
          phone?: string
          registered_at?: string
          status?: Database["public"]["Enums"]["member_status"]
          team_id?: string | null
          tendency?: string | null
          user_id: string
          win_history?: string | null
        }
        Update: {
          assigned_staff_id?: string | null
          consult_status?: string | null
          grade?: Database["public"]["Enums"]["grade"]
          id?: string
          inflow_code?: string | null
          inflow_type?: string | null
          is_deleted?: boolean
          is_suspended?: boolean
          is_withdrawn?: boolean
          last_active_at?: string | null
          memo?: string | null
          meta?: Json
          name?: string
          nickname?: string | null
          outcall_done?: boolean
          phone?: string
          registered_at?: string
          status?: Database["public"]["Enums"]["member_status"]
          team_id?: string | null
          tendency?: string | null
          user_id?: string
          win_history?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "members_assigned_staff_id_fkey"
            columns: ["assigned_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "members_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      nav_access: {
        Row: {
          nav_key: string
          roles: Database["public"]["Enums"]["role"][]
        }
        Insert: {
          nav_key: string
          roles?: Database["public"]["Enums"]["role"][]
        }
        Update: {
          nav_key?: string
          roles?: Database["public"]["Enums"]["role"][]
        }
        Relationships: []
      }
      notices: {
        Row: {
          author_id: string | null
          body: string
          created_at: string
          id: string
          pinned: boolean
          published: boolean
          title: string
          updated_at: string
          view_count: number
        }
        Insert: {
          author_id?: string | null
          body?: string
          created_at?: string
          id: string
          pinned?: boolean
          published?: boolean
          title: string
          updated_at?: string
          view_count?: number
        }
        Update: {
          author_id?: string | null
          body?: string
          created_at?: string
          id?: string
          pinned?: boolean
          published?: boolean
          title?: string
          updated_at?: string
          view_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "notices_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount: number
          created_at: string
          depositor_name: string | null
          id: string
          member_id: string
          meta: Json
          method: Database["public"]["Enums"]["payment_method"]
          paid_at: string | null
          period_end: string | null
          period_start: string | null
          pg_provider: string | null
          product_id: string | null
          staff_id: string | null
          status: Database["public"]["Enums"]["payment_status"]
        }
        Insert: {
          amount?: number
          created_at?: string
          depositor_name?: string | null
          id: string
          member_id: string
          meta?: Json
          method: Database["public"]["Enums"]["payment_method"]
          paid_at?: string | null
          period_end?: string | null
          period_start?: string | null
          pg_provider?: string | null
          product_id?: string | null
          staff_id?: string | null
          status?: Database["public"]["Enums"]["payment_status"]
        }
        Update: {
          amount?: number
          created_at?: string
          depositor_name?: string | null
          id?: string
          member_id?: string
          meta?: Json
          method?: Database["public"]["Enums"]["payment_method"]
          paid_at?: string | null
          period_end?: string | null
          period_start?: string | null
          pg_provider?: string | null
          product_id?: string | null
          staff_id?: string | null
          status?: Database["public"]["Enums"]["payment_status"]
        }
        Relationships: [
          {
            foreignKeyName: "payments_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          duration_months: number
          grade_granted: Database["public"]["Enums"]["grade"]
          id: string
          is_active: boolean
          name: string
          price: number
        }
        Insert: {
          duration_months?: number
          grade_granted: Database["public"]["Enums"]["grade"]
          id: string
          is_active?: boolean
          name: string
          price?: number
        }
        Update: {
          duration_months?: number
          grade_granted?: Database["public"]["Enums"]["grade"]
          id?: string
          is_active?: boolean
          name?: string
          price?: number
        }
        Relationships: []
      }
      site_settings: {
        Row: {
          app_download: Json
          auto_assign_cursor: string | null
          bank: Json
          business: Json
          call_keywords: Json
          call_script: string
          call_volume_alert_threshold: number
          generation_records: Json
          grade_colors: Json
          id: number
          join_sms_auto: boolean
          lotto_exclude: Json
          lotto_exclude_history: Json
          membership_tiers: Json
          pg_providers: Json
          promo_slides: Json
          report: Json
          sms: Json
          status_colors: Json
          terms: string
          terms_by_grade: Json
          weekly_free_reco: Json
          win_messages: Json
          win_sms: Json
          winner_stats: Json
        }
        Insert: {
          app_download?: Json
          auto_assign_cursor?: string | null
          bank?: Json
          business?: Json
          call_keywords?: Json
          call_script?: string
          call_volume_alert_threshold?: number
          generation_records?: Json
          grade_colors?: Json
          id?: number
          join_sms_auto?: boolean
          lotto_exclude?: Json
          lotto_exclude_history?: Json
          membership_tiers?: Json
          pg_providers?: Json
          promo_slides?: Json
          report?: Json
          sms?: Json
          status_colors?: Json
          terms?: string
          terms_by_grade?: Json
          weekly_free_reco?: Json
          win_messages?: Json
          win_sms?: Json
          winner_stats?: Json
        }
        Update: {
          app_download?: Json
          auto_assign_cursor?: string | null
          bank?: Json
          business?: Json
          call_keywords?: Json
          call_script?: string
          call_volume_alert_threshold?: number
          generation_records?: Json
          grade_colors?: Json
          id?: number
          join_sms_auto?: boolean
          lotto_exclude?: Json
          lotto_exclude_history?: Json
          membership_tiers?: Json
          pg_providers?: Json
          promo_slides?: Json
          report?: Json
          sms?: Json
          status_colors?: Json
          terms?: string
          terms_by_grade?: Json
          weekly_free_reco?: Json
          win_messages?: Json
          win_sms?: Json
          winner_stats?: Json
        }
        Relationships: []
      }
      sms_sends: {
        Row: {
          body: string
          id: string
          member_id: string
          meta: Json
          phone: string
          sent_at: string | null
          status: string
          template_key: string | null
          type: Database["public"]["Enums"]["sms_type"]
        }
        Insert: {
          body?: string
          id: string
          member_id: string
          meta?: Json
          phone?: string
          sent_at?: string | null
          status?: string
          template_key?: string | null
          type?: Database["public"]["Enums"]["sms_type"]
        }
        Update: {
          body?: string
          id?: string
          member_id?: string
          meta?: Json
          phone?: string
          sent_at?: string | null
          status?: string
          template_key?: string | null
          type?: Database["public"]["Enums"]["sms_type"]
        }
        Relationships: [
          {
            foreignKeyName: "sms_sends_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_templates: {
        Row: {
          body: string
          category: string
          key: string
          title: string
        }
        Insert: {
          body: string
          category?: string
          key: string
          title: string
        }
        Update: {
          body?: string
          category?: string
          key?: string
          title?: string
        }
        Relationships: []
      }
      staff: {
        Row: {
          auth_user_id: string | null
          auto_assign_enabled: boolean
          id: string
          is_active: boolean
          last_login_at: string | null
          login_id: string
          name: string
          role: Database["public"]["Enums"]["role"]
          team_id: string | null
        }
        Insert: {
          auth_user_id?: string | null
          auto_assign_enabled?: boolean
          id: string
          is_active?: boolean
          last_login_at?: string | null
          login_id: string
          name: string
          role?: Database["public"]["Enums"]["role"]
          team_id?: string | null
        }
        Update: {
          auth_user_id?: string | null
          auto_assign_enabled?: boolean
          id?: string
          is_active?: boolean
          last_login_at?: string | null
          login_id?: string
          name?: string
          role?: Database["public"]["Enums"]["role"]
          team_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "staff_team_fk"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      teams: {
        Row: {
          id: string
          leader_id: string | null
          name: string
        }
        Insert: {
          id: string
          leader_id?: string | null
          name: string
        }
        Update: {
          id?: string
          leader_id?: string | null
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "teams_leader_fk"
            columns: ["leader_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      unmatched_call_recordings: {
        Row: {
          created_at: string
          file_name: string
          file_path: string
          id: string
          normalized_phone: string
          raw_phone: string
          recorded_at: string | null
          resolved_at: string | null
          resolved_member_id: string | null
          uploaded_by: string | null
        }
        Insert: {
          created_at?: string
          file_name: string
          file_path: string
          id: string
          normalized_phone: string
          raw_phone: string
          recorded_at?: string | null
          resolved_at?: string | null
          resolved_member_id?: string | null
          uploaded_by?: string | null
        }
        Update: {
          created_at?: string
          file_name?: string
          file_path?: string
          id?: string
          normalized_phone?: string
          raw_phone?: string
          recorded_at?: string | null
          resolved_at?: string | null
          resolved_member_id?: string | null
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "unmatched_call_recordings_resolved_member_id_fkey"
            columns: ["resolved_member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "unmatched_call_recordings_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      admin_bets_page: {
        Args: {
          p_limit?: number
          p_offset?: number
          p_round?: number
          p_search?: string
        }
        Returns: Json
      }
      admin_consult_report: {
        Args: {
          p_dimension: string
          p_from: string
          p_period: string
          p_source_site?: string
          p_to: string
        }
        Returns: Json
      }
      admin_dashboard: { Args: { p_source_site?: string }; Returns: Json }
      admin_delete_member_reco: {
        Args: { p_issued_at: string; p_member_id: string; p_round_no: number }
        Returns: Json
      }
      admin_member_facets: {
        Args: { p_assigned_staff_id?: string; p_source_site?: string }
        Returns: Json
      }
      admin_member_search: {
        Args: { p_limit?: number; p_source_site?: string; p_term?: string }
        Returns: Json
      }
      admin_members_page: {
        Args: {
          p_assigned_staff_id?: string
          p_filter?: Json
          p_limit?: number
          p_offset?: number
          p_sort_desc?: boolean
          p_sort_id?: string
        }
        Returns: Json
      }
      admin_nav_badges: { Args: { p_source_site?: string }; Returns: Json }
      admin_payment_counts: { Args: { p_source_site?: string }; Returns: Json }
      admin_payment_detail: { Args: { p_id: string }; Returns: Json }
      admin_payments_page: {
        Args: {
          p_filter?: Json
          p_limit?: number
          p_offset?: number
          p_sort_desc?: boolean
          p_sort_id?: string
        }
        Returns: Json
      }
      admin_revenue: {
        Args: {
          p_from: string
          p_group?: string
          p_source_site?: string
          p_to: string
          p_view: string
        }
        Returns: Json
      }
      admin_revenue_calendar: {
        Args: { p_month: string; p_source_site?: string; p_view?: string }
        Returns: Json
      }
      admin_revenue_daily_summary: {
        Args: { p_from: string; p_source_site?: string; p_to: string }
        Returns: Json
      }
      admin_revenue_day_payments: {
        Args: { p_day: string; p_source_site?: string; p_view?: string }
        Returns: Json
      }
      admin_stats_snapshot: {
        Args: {
          p_from: string
          p_source_site?: string
          p_to: string
          p_view: string
        }
        Returns: Json
      }
      admin_validate_source_site: {
        Args: { p_source_site: string }
        Returns: string
      }
      app_can_see_member: { Args: { mid: string }; Returns: boolean }
      app_role: { Args: never; Returns: Database["public"]["Enums"]["role"] }
      app_staff_id: { Args: never; Returns: string }
      app_team: { Args: never; Returns: string }
      app_touch_login: { Args: never; Returns: undefined }
      canonical_inflow_type: { Args: { p_value: string }; Returns: string }
      member_operating_site: {
        Args: { "": Database["public"]["Tables"]["members"]["Row"] }
        Returns: {
          error: true
        } & "the function public.member_operating_site with parameter or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache"
      }
      portal_member_recos: {
        Args: { p_phone: string; p_pw: string }
        Returns: Json
      }
      portal_membership_tiers: { Args: never; Returns: Json }
      portal_site_public: { Args: never; Returns: Json }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
    }
    Enums: {
      assign_type: "manual" | "auto"
      grade:
        | "simple"
        | "free"
        | "gold"
        | "goldp"
        | "vip"
        | "royal"
        | "ovr"
        | "toss"
      inquiry_status: "open" | "answered"
      log_kind: "admin" | "point" | "sms" | "payment" | "inflow"
      member_status: "active" | "suspended" | "deleted" | "withdrawn"
      payment_method: "bank" | "manual" | "pg"
      payment_status: "wait" | "approved" | "failed" | "cancelled"
      report_frequency: "daily" | "weekly" | "monthly"
      role: "admin" | "manager" | "leader" | "rep"
      sms_type: "join" | "recommend" | "win" | "marketing" | "direct" | "terms"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      assign_type: ["manual", "auto"],
      grade: ["simple", "free", "gold", "goldp", "vip", "royal", "ovr", "toss"],
      inquiry_status: ["open", "answered"],
      log_kind: ["admin", "point", "sms", "payment", "inflow"],
      member_status: ["active", "suspended", "deleted", "withdrawn"],
      payment_method: ["bank", "manual", "pg"],
      payment_status: ["wait", "approved", "failed", "cancelled"],
      report_frequency: ["daily", "weekly", "monthly"],
      role: ["admin", "manager", "leader", "rep"],
      sms_type: ["join", "recommend", "win", "marketing", "direct", "terms"],
    },
  },
} as const
