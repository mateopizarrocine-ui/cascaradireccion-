/* ============================================================
 * Cáscara Planificación · App layer
 * Conecta el form a Supabase (schema "planificacion")
 * Fase 0 — auth simple por selección de usuario, sin RLS
 * ============================================================ */

const CASCARA_CONFIG = {
  SUPABASE_URL: 'https://hcapghjnhmiaojeqragk.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhjYXBnaGpuaG1pYW9qZXFyYWdrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0MzAxMzUsImV4cCI6MjA5MzAwNjEzNX0.WjgY_4A71rykgUIaYVgt7Dh9RwZMmIltByPjfV1qgPk',
  SAVE_DEBOUNCE_MS: 1500,
};

const Cascara = {
  client: null,
  state: {
    user: null,          // DB user
    area: null,          // DB area
    quarter: null,       // DB current quarter
    plan: null,          // DB plan (or null)
    saveTimers: new Map(),
    saveStatus: 'idle',  // 'idle' | 'saving' | 'saved' | 'error'
    ready: false,
  },

  // ---------- INIT ----------
  async init() {
    // Bloquear la UI hasta que estemos listos
    document.body.classList.add('cascara-not-ready');
    // Si hay sesión en cache, marcamos restoring para ocultar el login (evita flash)
    const cachedUserId = localStorage.getItem('cascara_user_id');
    if (cachedUserId) document.body.classList.add('cascara-restoring');
    if (!window.supabase) {
      console.error('[Cascara] Supabase SDK no cargó');
      return;
    }
    this.client = window.supabase.createClient(
      CASCARA_CONFIG.SUPABASE_URL,
      CASCARA_CONFIG.SUPABASE_ANON_KEY,
      { db: { schema: 'planificacion' } }
    );

    // Quarter actual (estado planning o in_progress)
    const { data: quarter, error: qErr } = await this.client
      .from('quarters')
      .select('*')
      .in('status', ['planning', 'in_progress'])
      .order('start_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (qErr) console.warn('[Cascara] quarter:', qErr);
    this.state.quarter = quarter;
    // Si el SC cambia el audit_status remoto, podemos suscribirnos vía realtime
    // (Fase posterior). Por ahora, cada navegación re-lee el quarter.

    // Restaurar sesión
    const storedUserId = localStorage.getItem('cascara_user_id');
    if (storedUserId) {
      await this.loadUserById(storedUserId);
    }

    this.state.ready = true;
    this.setupSaveIndicator();
    // UI ya está lista para recibir clicks
    document.body.classList.remove('cascara-not-ready');
    // Si NO hay sesión válida, mostrar login (sacar restoring si quedó colgado por sesión inválida)
    if (!this.state.user) document.body.classList.remove('cascara-restoring');
    document.dispatchEvent(new CustomEvent('cascara:ready'));
  },

  // ---------- USERS ----------
  async listUsers() {
    const { data, error } = await this.client
      .from('users')
      .select('*, area:areas(*)')
      .order('role')
      .order('name');
    if (error) console.warn('[Cascara] listUsers:', error);
    return data || [];
  },

  async loadUserById(id) {
    const { data: user, error } = await this.client
      .from('users')
      .select('*, area:areas(*)')
      .eq('id', id)
      .maybeSingle();
    if (error || !user) {
      localStorage.removeItem('cascara_user_id');
      return null;
    }
    this.state.user = user;
    this.state.area = user.area;
    return user;
  },

  async login(userId) {
    localStorage.setItem('cascara_user_id', userId);
    const user = await this.loadUserById(userId);
    if (user) document.dispatchEvent(new CustomEvent('cascara:user-changed', { detail: user }));
    return user;
  },

  logout() {
    localStorage.removeItem('cascara_user_id');
    this.state.user = null;
    this.state.area = null;
    this.state.plan = null;
    document.dispatchEvent(new CustomEvent('cascara:user-changed', { detail: null }));
  },

  isAdmin() {
    return this.state.user?.role === 'admin';
  },

  // ---------- PLAN ----------
  async loadExistingPlan(areaId = null, quarterId = null) {
    const a = areaId || this.state.area?.id;
    const q = quarterId || this.state.quarter?.id;
    if (!a || !q) return null;
    const { data } = await this.client
      .from('plans')
      .select('*')
      .eq('area_id', a)
      .eq('quarter_id', q)
      .maybeSingle();
    this.state.plan = data || null;
    return data || null;
  },

  async getOrCreatePlan(areaId = null, quarterId = null) {
    const a = areaId || this.state.area?.id;
    const q = quarterId || this.state.quarter?.id;
    if (!a || !q) return null;

    let plan = await this.loadExistingPlan(a, q);
    if (!plan) {
      const ins = await this.client
        .from('plans')
        .insert({
          area_id: a,
          quarter_id: q,
          director_user_id: this.state.user?.role === 'admin' ? null : this.state.user?.id,
        })
        .select()
        .single();
      plan = ins.data;
      this.state.plan = plan;
    }
    return plan;
  },

  async updatePlanField(field, value) {
    if (!this.state.plan) return;
    this.setSaveStatus('saving');
    const { error } = await this.client
      .from('plans')
      .update({ [field]: value })
      .eq('id', this.state.plan.id);
    if (error) {
      console.warn('[Cascara] save plan field', field, error);
      this.setSaveStatus('error');
    } else {
      this.state.plan[field] = value;
      this.setSaveStatus('saved');
    }
  },

  // ---------- PROJECTS ----------
  async listProjects(planId = null) {
    const id = planId || this.state.plan?.id;
    if (!id) return [];
    const { data, error } = await this.client
      .from('projects')
      .select('*, kpis(*)')
      .eq('plan_id', id)
      .order('order_index');
    if (error) console.warn('[Cascara] listProjects:', error);
    return (data || []).map(p => ({ ...p, kpis: (p.kpis || []).sort((a,b)=>a.order_index-b.order_index) }));
  },

  async createProject(planId) {
    const { data: existing } = await this.client
      .from('projects')
      .select('order_index')
      .eq('plan_id', planId)
      .order('order_index', { ascending: false })
      .limit(1);
    const nextIndex = (existing?.[0]?.order_index || 0) + 1;
    const { data } = await this.client
      .from('projects')
      .insert({ plan_id: planId, order_index: nextIndex, name: '' })
      .select()
      .single();
    return data;
  },

  async updateProjectField(projectId, field, value) {
    this.setSaveStatus('saving');
    const { error } = await this.client
      .from('projects')
      .update({ [field]: value })
      .eq('id', projectId);
    if (error) { console.warn(error); this.setSaveStatus('error'); }
    else this.setSaveStatus('saved');
  },

  async deleteProject(projectId) {
    const { error } = await this.client
      .from('projects')
      .delete()
      .eq('id', projectId);
    if (error) console.warn(error);
  },

  // Articulación libre (used by Marketing form — sin pre-asignar área)
  async createArticulation(opts = {}) {
    const planId = opts.plan_id || this.state.plan?.id;
    if (!planId) return null;
    const { data } = await this.client
      .from('articulations')
      .insert({ plan_id: planId, with_area_id: opts.with_area_id || null })
      .select()
      .single();
    return data;
  },

  async updateArticulationField(id, field, value) {
    this.setSaveStatus('saving');
    const { error } = await this.client
      .from('articulations')
      .update({ [field]: value })
      .eq('id', id);
    if (error) { console.warn(error); this.setSaveStatus('error'); }
    else this.setSaveStatus('saved');
  },

  // ---------- TEAM MEMBERS ----------
  async listTeamMembers(planId = null) {
    const id = planId || this.state.plan?.id;
    if (!id) return [];
    const { data } = await this.client
      .from('team_members')
      .select('*')
      .eq('plan_id', id)
      .order('order_index');
    return data || [];
  },

  async createTeamMember(planId) {
    const { data: existing } = await this.client
      .from('team_members')
      .select('order_index')
      .eq('plan_id', planId)
      .order('order_index', { ascending: false })
      .limit(1);
    const nextIndex = (existing?.[0]?.order_index || 0) + 1;
    const { data } = await this.client
      .from('team_members')
      .insert({ plan_id: planId, order_index: nextIndex })
      .select()
      .single();
    return data;
  },

  async updateTeamMemberField(id, field, value) {
    this.setSaveStatus('saving');
    const { error } = await this.client.from('team_members').update({ [field]: value }).eq('id', id);
    if (error) { console.warn(error); this.setSaveStatus('error'); }
    else this.setSaveStatus('saved');
  },

  async deleteTeamMember(id) {
    await this.client.from('team_members').delete().eq('id', id);
  },

  // ---------- KPIs ----------
  async createKpi(projectId) {
    const { data: existing } = await this.client
      .from('kpis')
      .select('order_index')
      .eq('project_id', projectId)
      .order('order_index', { ascending: false })
      .limit(1);
    const nextIndex = (existing?.[0]?.order_index || 0) + 1;
    const { data } = await this.client.from('kpis').insert({ project_id: projectId, order_index: nextIndex }).select().single();
    return data;
  },

  async updateKpiField(id, field, value) {
    this.setSaveStatus('saving');
    const { error } = await this.client.from('kpis').update({ [field]: value }).eq('id', id);
    if (error) { console.warn(error); this.setSaveStatus('error'); }
    else this.setSaveStatus('saved');
  },

  async deleteKpi(id) {
    await this.client.from('kpis').delete().eq('id', id);
  },

  // ---------- IMPORT from previous Q ----------
  async getPreviousQuarter() {
    if (!this.state.quarter) return null;
    const { data } = await this.client
      .from('quarters')
      .select('*')
      .lt('start_date', this.state.quarter.start_date)
      .order('start_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data;
  },

  async importSectionFromPreviousQ(section) {
    const prevQ = await this.getPreviousQuarter();
    if (!prevQ) {
      alert('No hay Q anterior cargado todavía. Cuando termine este Q vas a poder importar desde el próximo plan.');
      return false;
    }
    if (!this.state.area || !this.state.plan) return false;

    const { data: prevPlan } = await this.client
      .from('plans')
      .select('*')
      .eq('area_id', this.state.area.id)
      .eq('quarter_id', prevQ.id)
      .maybeSingle();

    if (!prevPlan) {
      alert(`No hay plan cargado para ${this.state.area.name} en ${prevQ.name}.`);
      return false;
    }

    switch (section) {
      case 'vision':
        await this.client.from('plans').update({
          vision_text: prevPlan.vision_text,
          vision_macro_text: prevPlan.vision_macro_text,
        }).eq('id', this.state.plan.id);
        break;
      case 'projects': {
        const { data: prevProjects } = await this.client.from('projects').select('*, kpis(*)').eq('plan_id', prevPlan.id);
        for (const proj of (prevProjects || [])) {
          const { data: newProj } = await this.client.from('projects').insert({
            plan_id: this.state.plan.id,
            order_index: proj.order_index,
            name: proj.name,
            responsible_name: proj.responsible_name,
            subresponsables: proj.subresponsables,
            what_it_means: proj.what_it_means,
            hypothesis: proj.hypothesis,
            objective: proj.objective,
            why_priority: proj.why_priority,
            business_impact: proj.business_impact,
            what_implies: proj.what_implies,
            status: 'proposed',
          }).select().single();
          if (newProj && proj.kpis) {
            for (const k of proj.kpis) {
              await this.client.from('kpis').insert({
                project_id: newProj.id,
                order_index: k.order_index,
                name: k.name, target: k.target, deadline: k.deadline,
              });
            }
          }
        }
        break;
      }
      case 'team': {
        const { data: prevTeam } = await this.client.from('team_members').select('*').eq('plan_id', prevPlan.id);
        for (const t of (prevTeam || [])) {
          await this.client.from('team_members').insert({
            plan_id: this.state.plan.id,
            order_index: t.order_index,
            name: t.name, role: t.role, dedication: t.dedication, status: t.status, goal: t.goal,
          });
        }
        break;
      }
      default:
        alert('Sección no implementada para importar todavía.');
        return false;
    }
    return true;
  },

  // ---------- ARTICULATIONS ----------
  async listArticulations(planId = null) {
    const id = planId || this.state.plan?.id;
    if (!id) return [];
    const { data } = await this.client.from('articulations').select('*, with_area:areas(*)').eq('plan_id', id).order('order_index');
    return data || [];
  },
  async upsertArticulation(planId, withAreaId, fields) {
    const { data: existing } = await this.client.from('articulations')
      .select('id').eq('plan_id', planId).eq('with_area_id', withAreaId).maybeSingle();
    if (existing) {
      this.setSaveStatus('saving');
      const { error } = await this.client.from('articulations').update(fields).eq('id', existing.id);
      if (error) { this.setSaveStatus('error'); return null; }
      this.setSaveStatus('saved');
      return existing.id;
    } else {
      const { data, error } = await this.client.from('articulations').insert({ plan_id: planId, with_area_id: withAreaId, ...fields }).select().single();
      if (error) { this.setSaveStatus('error'); return null; }
      this.setSaveStatus('saved');
      return data.id;
    }
  },

  // ---------- PROJECT MILESTONES ----------
  async listProjectMilestones(projectId) {
    const { data } = await this.client.from('project_milestones')
      .select('*').eq('project_id', projectId).order('due_date', { nullsFirst: false }).order('order_index');
    return data || [];
  },
  async createMilestone(projectId) {
    const { data: existing } = await this.client.from('project_milestones')
      .select('order_index').eq('project_id', projectId).order('order_index', { ascending: false }).limit(1);
    const nextIndex = (existing?.[0]?.order_index || 0) + 1;
    const { data } = await this.client.from('project_milestones').insert({
      project_id: projectId, order_index: nextIndex, title: ''
    }).select().single();
    return data;
  },
  async updateMilestoneField(id, field, value) {
    this.setSaveStatus('saving');
    const { error } = await this.client.from('project_milestones').update({ [field]: value }).eq('id', id);
    if (error) { console.warn(error); this.setSaveStatus('error'); } else this.setSaveStatus('saved');
  },
  async toggleMilestoneStatus(id, currentStatus) {
    const newStatus = currentStatus === 'done' ? 'pending' : 'done';
    await this.client.from('project_milestones').update({ status: newStatus }).eq('id', id);
    return newStatus;
  },
  async deleteMilestone(id) {
    await this.client.from('project_milestones').delete().eq('id', id);
  },

  // ---------- CALENDAR MONTHS ----------
  async listCalendarMonths(planId = null) {
    const id = planId || this.state.plan?.id;
    if (!id) return [];
    const { data } = await this.client.from('calendar_months').select('*').eq('plan_id', id).order('order_index');
    return data || [];
  },
  async upsertCalendarMonth(planId, monthLabel, orderIndex, milestones) {
    const { data: existing } = await this.client.from('calendar_months')
      .select('id').eq('plan_id', planId).eq('order_index', orderIndex).maybeSingle();
    if (existing) {
      this.setSaveStatus('saving');
      const { error } = await this.client.from('calendar_months').update({ milestones, month_label: monthLabel }).eq('id', existing.id);
      if (error) { this.setSaveStatus('error'); return null; }
      this.setSaveStatus('saved');
      return existing.id;
    } else {
      const { data, error } = await this.client.from('calendar_months').insert({ plan_id: planId, order_index: orderIndex, month_label: monthLabel, milestones }).select().single();
      if (error) { this.setSaveStatus('error'); return null; }
      this.setSaveStatus('saved');
      return data.id;
    }
  },

  // ---------- ADMIN: TODOS LOS PLANES ----------
  async listAllPlansForQuarter(quarterId = null) {
    const qid = quarterId || this.state.quarter?.id;
    if (!qid) return [];
    const { data } = await this.client
      .from('plans')
      .select('*, area:areas(*), director:users!plans_director_user_id_fkey(*), projects(id), comments(id, resolved)')
      .eq('quarter_id', qid);
    if (!data) return [];
    return data.map(p => ({
      ...p,
      projects_count: p.projects?.length || 0,
      comments_open: (p.comments || []).filter(c => !c.resolved).length,
    })).sort((a, b) => (a.area?.order_index || 99) - (b.area?.order_index || 99));
  },

  // ---------- CHECK-INS (por sesión, 1 sesión = todos los proyectos del área) ----------
  async listProjectsOfMyArea() {
    if (!this.state.area || !this.state.quarter) return [];
    // Resolver mi plan
    const { data: plan } = await this.client.from('plans')
      .select('id').eq('area_id', this.state.area.id).eq('quarter_id', this.state.quarter.id).maybeSingle();
    if (!plan) return [];
    const { data: projects } = await this.client.from('projects')
      .select('id, name, responsible_name, order_index').eq('plan_id', plan.id).order('order_index');
    return projects || [];
  },
  async listSessionsForMyPlan() {
    if (!this.state.area || !this.state.quarter) return [];
    const { data: plan } = await this.client.from('plans')
      .select('id').eq('area_id', this.state.area.id).eq('quarter_id', this.state.quarter.id).maybeSingle();
    if (!plan) return [];
    const { data: sessions } = await this.client.from('check_in_sessions')
      .select('*, entries:check_ins(*, project:projects(name))').eq('plan_id', plan.id).order('created_at', { ascending: false });
    return sessions || [];
  },
  async createCheckInSession({ summary, entries }) {
    if (!this.state.user || !this.state.area || !this.state.quarter) return null;
    const { data: plan } = await this.client.from('plans')
      .select('id').eq('area_id', this.state.area.id).eq('quarter_id', this.state.quarter.id).maybeSingle();
    if (!plan) return null;
    // 1. Crear la sesión
    const { data: session, error: sErr } = await this.client.from('check_in_sessions').insert({
      plan_id: plan.id,
      author_user_id: this.state.user.id,
      author_name: this.state.user.name,
      summary: summary || null,
    }).select().single();
    if (sErr || !session) return null;
    // 2. Insertar todas las entradas
    if (entries && entries.length) {
      const rows = entries.map(e => ({
        session_id: session.id,
        project_id: e.project_id,
        author_user_id: this.state.user.id,
        author_name: this.state.user.name,
        status: e.status,
        note: e.note || null,
        blocker: e.blocker || null,
      }));
      await this.client.from('check_ins').insert(rows);
    }
    return session;
  },

  // ---------- AUDIT SESSION · Master Timeline ----------
  async isStrategyCouncil(userId = null) {
    const uid = userId || this.state.user?.id;
    if (!uid) return false;
    const { data } = await this.client.from('strategy_council_members').select('id').eq('user_id', uid).maybeSingle();
    return !!data;
  },

  async getAuditStatus(quarterId = null) {
    const qid = quarterId || this.state.quarter?.id;
    if (!qid) return 'planning';
    const { data } = await this.client.from('quarters').select('audit_status').eq('id', qid).maybeSingle();
    return data?.audit_status || 'planning';
  },

  // Capa 2 está abierta si el master timeline está locked, en ejecución o cerrado
  isCapa2Open(auditStatus) {
    return ['timeline_locked', 'execution', 'closed'].includes(auditStatus);
  },

  async listProjectsForAudit(quarterId = null) {
    const qid = quarterId || this.state.quarter?.id;
    if (!qid) return [];
    // Todos los proyectos de todas las áreas del Q
    const { data } = await this.client
      .from('projects')
      .select('*, plan:plans(area:areas(id,name,slug,color,order_index))')
      .order('order_index');
    const flat = (data || []).filter(p => p.plan?.area).map(p => ({
      ...p,
      area_id: p.plan.area.id,
      area_name: p.plan.area.name,
      area_slug: p.plan.area.slug,
      area_color: p.plan.area.color,
      area_order: p.plan.area.order_index,
    }));
    // Solo los del quarter en curso
    const { data: plansForQ } = await this.client.from('plans').select('id').eq('quarter_id', qid);
    const planIds = new Set((plansForQ || []).map(p => p.id));
    return flat.filter(p => planIds.has(p.plan_id));
  },

  async listTimelineEntries(quarterId = null) {
    const qid = quarterId || this.state.quarter?.id;
    if (!qid) return [];
    const { data } = await this.client.from('q_timeline').select('*').eq('quarter_id', qid).order('start_fortnight').order('sequence_order');
    return data || [];
  },

  async upsertTimelineEntry(projectId, startFortnight, endFortnight, sequenceOrder, notes) {
    if (!this.state.quarter) return null;
    const isSC = await this.isStrategyCouncil();
    if (!isSC && !this.isAdmin()) return null;
    const { data: existing } = await this.client
      .from('q_timeline').select('id')
      .eq('quarter_id', this.state.quarter.id).eq('project_id', projectId).maybeSingle();
    if (existing) {
      this.setSaveStatus('saving');
      const { error } = await this.client.from('q_timeline').update({
        start_fortnight: startFortnight,
        end_fortnight: endFortnight || startFortnight,
        sequence_order: sequenceOrder || 0,
        notes: notes || null,
        assigned_by: this.state.user?.id,
      }).eq('id', existing.id);
      if (error) { this.setSaveStatus('error'); return null; }
      this.setSaveStatus('saved');
      return existing.id;
    }
    const { data, error } = await this.client.from('q_timeline').insert({
      quarter_id: this.state.quarter.id,
      project_id: projectId,
      start_fortnight: startFortnight,
      end_fortnight: endFortnight || startFortnight,
      sequence_order: sequenceOrder || 0,
      notes: notes || null,
      assigned_by: this.state.user?.id,
    }).select().single();
    if (error) { this.setSaveStatus('error'); return null; }
    this.setSaveStatus('saved');
    return data.id;
  },

  async updateQuarterStartDate(newDateISO) {
    if (!this.state.quarter) return { ok: false, error: 'no-quarter' };
    if (!this.isAdmin()) return { ok: false, error: 'not-admin' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newDateISO)) return { ok: false, error: 'bad-date' };
    const patch = { start_date: newDateISO };
    // end_date opcional: 11 semanas (77 días) después de start, para que la duración del Q quede consistente con las 6 quincenas + apertura/cierre
    const start = new Date(newDateISO + 'T00:00:00');
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 77);
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    patch.end_date = fmt(end);
    const { error } = await this.client.from('quarters').update(patch).eq('id', this.state.quarter.id);
    if (error) return { ok: false, error: error.message };
    this.state.quarter.start_date = patch.start_date;
    this.state.quarter.end_date = patch.end_date;
    document.dispatchEvent(new CustomEvent('cascara:quarter-dates-changed', { detail: patch }));
    return { ok: true, patch };
  },

  async setAuditStatus(newStatus) {
    if (!this.state.quarter) return;
    const isSC = await this.isStrategyCouncil();
    if (!isSC && !this.isAdmin()) return;
    const patch = { audit_status: newStatus };
    if (newStatus === 'timeline_locked') {
      patch.timeline_locked_at = new Date().toISOString();
      patch.timeline_locked_by = this.state.user?.id;
    }
    await this.client.from('quarters').update(patch).eq('id', this.state.quarter.id);
    // Actualizar state local
    this.state.quarter.audit_status = newStatus;
    document.dispatchEvent(new CustomEvent('cascara:audit-status-changed', { detail: newStatus }));
  },

  // ---------- COMMENTS ----------
  async listComments(planId, targetType = null, targetId = null) {
    let q = this.client.from('comments').select('*').eq('plan_id', planId).order('created_at');
    if (targetType) q = q.eq('target_type', targetType);
    if (targetId) q = q.eq('target_id', targetId);
    const { data } = await q;
    return data || [];
  },
  async listCommentsByField(planId, targetType, targetId, fieldPath) {
    const { data } = await this.client.from('comments').select('*')
      .eq('plan_id', planId).eq('target_type', targetType).eq('field_path', fieldPath)
      .eq(targetId ? 'target_id' : 'plan_id', targetId || planId)
      .order('created_at');
    return data || [];
  },

  async addComment(planId, targetType, targetId, fieldPath, text) {
    if (!this.state.user) return null;
    const { data } = await this.client.from('comments').insert({
      plan_id: planId,
      target_type: targetType,
      target_id: targetId,
      field_path: fieldPath,
      author_user_id: this.state.user.id,
      author_name: this.state.user.name,
      text,
    }).select().single();
    return data;
  },

  async resolveComment(commentId, resolved = true) {
    await this.client.from('comments').update({ resolved }).eq('id', commentId);
  },

  // ---------- DEBOUNCED SAVE ----------
  debouncedSave(key, fn) {
    clearTimeout(this.state.saveTimers.get(key));
    this.state.saveTimers.set(
      key,
      setTimeout(() => fn(), CASCARA_CONFIG.SAVE_DEBOUNCE_MS)
    );
  },

  // ---------- SAVE INDICATOR ----------
  setupSaveIndicator() {
    if (document.getElementById('cascara-save-pill')) return;
    const pill = document.createElement('div');
    pill.id = 'cascara-save-pill';
    pill.innerHTML = '<span class="dot"></span><span class="txt">Borrador guardado</span>';
    document.body.appendChild(pill);

    const style = document.createElement('style');
    style.textContent = `
      #cascara-save-pill {
        position: fixed; bottom: 24px; right: 24px;
        background: rgba(10,10,12,0.92); color: #fff;
        padding: 10px 16px; border-radius: 999px;
        font: 500 12.5px 'Helvetica Neue', sans-serif;
        display: flex; align-items: center; gap: 10px;
        opacity: 0; transform: translateY(8px);
        transition: opacity .2s, transform .2s;
        z-index: 9999; pointer-events: none;
        letter-spacing: 0.02em;
      }
      #cascara-save-pill.visible { opacity: 1; transform: translateY(0); }
      #cascara-save-pill .dot {
        width: 8px; height: 8px; border-radius: 50%; background: #00B36B;
      }
      #cascara-save-pill[data-status="saving"] .dot { background: #C39A00; animation: pulse 1s infinite; }
      #cascara-save-pill[data-status="error"] .dot { background: #E53935; }
      @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
    `;
    document.head.appendChild(style);
  },

  setSaveStatus(status) {
    this.state.saveStatus = status;
    const pill = document.getElementById('cascara-save-pill');
    if (!pill) return;
    pill.dataset.status = status;
    const txt = pill.querySelector('.txt');
    if (status === 'saving') txt.textContent = 'Guardando…';
    else if (status === 'saved') txt.textContent = 'Borrador guardado';
    else if (status === 'error') txt.textContent = 'Error al guardar';
    pill.classList.add('visible');
    if (this._pillTimer) clearTimeout(this._pillTimer);
    if (status !== 'saving') {
      this._pillTimer = setTimeout(() => pill.classList.remove('visible'), 2200);
    }
  },
};

window.Cascara = Cascara;

/* ============================================================
 * Layout: home en una pantalla sin scroll
 * ============================================================ */
(function injectHomeFitCSS() {
  if (document.getElementById('cascara-home-fit-style')) return;
  const s = document.createElement('style');
  s.id = 'cascara-home-fit-style';
  s.textContent = `
    @media (min-width: 900px) {
      #view-home, #view-home.active { height: 100vh; overflow: hidden; }
      #view-home .home-app { min-height: 100vh; height: 100vh; padding: 22px 32px 22px; gap: 18px; }
      #view-home .greeting { gap: 18px; }
      #view-home .greet-title { font-size: clamp(30px, 3.6vw, 46px); line-height: 0.95; }
      #view-home .greet-text { gap: 8px; }
      #view-home .greet-meta { padding-left: 18px; gap: 22px; }
      #view-home .gmi-val { font-size: 15px; }
      #view-home .cards-grid { gap: 14px; min-height: 0; flex: 1; overflow: hidden; }
      #view-home .hcard { display: flex; min-height: 0; }
      #view-home .hcard-inner { padding: 24px 22px; gap: 14px; height: 100%; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
      #view-home .hcard-tag { font-size: 10.5px; letter-spacing: 0.18em; }
      #view-home .hcard-head { gap: 8px; }
      #view-home .hcard-title { font-size: clamp(28px, 3vw, 38px); line-height: 0.95; }
      #view-home .hcard-lead { font-size: 12.5px; line-height: 1.45; max-height: 4em; overflow: hidden; }
      #view-home .hcard-status { gap: 10px; padding-top: 12px; }
      #view-home .hcs-lbl { font-size: 10.5px; }
      #view-home .hcs-val { font-size: 12.5px; }
      #view-home .hcs-pct { font-size: 26px; }
      #view-home .hcard-progress { height: 4px; }
      #view-home .hcard-checks { gap: 4px 8px; }
      #view-home .hck { padding: 5px 8px; font-size: 10.5px; }
      #view-home .hck-num { font-size: 9px; }
      #view-home .hck-label { font-size: 10.5px; }
      #view-home .hcard-cta { padding: 12px 16px; margin-top: auto; }
      #view-home .hcard-cta-lbl { font-size: 9.5px; }
      #view-home .hcard-cta-action { font-size: 13px; }
      #view-home .areas-list { gap: 4px; flex: 1; overflow-y: auto; min-height: 0; }
      #view-home .area-row { padding: 8px 12px; }
      #view-home .area-name { font-size: 12.5px; }
      #view-home .area-director { font-size: 10.5px; }
      #view-home .area-num { font-size: 10.5px; }
      #view-home .area-status { font-size: 9.5px; padding: 3px 8px; }
      #view-home .area-action { font-size: 10px; }
      #view-home .unlock-hint { display: none; }
      #view-home .presos-mini-list { gap: 4px; flex: 1; overflow-y: auto; min-height: 0; }
      #view-home .preso-mini { padding: 8px 14px; font-size: 12.5px; }
      #view-home .preso-mini .num { font-size: 11px; }
      #view-home .hcard-sticker { transform: scale(0.85); }
      #view-home .footer-link { display: none; }
    }
  `;
  document.head.appendChild(s);
})();

/* ============================================================
 * BINDING — conecta el form HTML con la DB
 * ============================================================ */
const CascaraForm = {
  formView: null,
  inited: false,

  // ---------- ENTRY POINT ----------
  async enter() {
    this.formView = document.getElementById('view-formulario');
    if (!this.formView) return;

    if (!Cascara.state.ready) {
      await new Promise(res => document.addEventListener('cascara:ready', res, { once: true }));
    }
    if (!Cascara.state.user) {
      console.warn('[CascaraForm] sin usuario, no se puede cargar plan');
      alert('Tu sesión no está identificada correctamente. Volvé a iniciar sesión.');
      goTo('login');
      return;
    }

    // DEFENSIVO: para directores, FORZAR siempre su propia área. Nunca dejar que
    // editen el plan de otra área por error (riesgo de sobreescribir datos ajenos).
    if (Cascara.state.user.role === 'director') {
      Cascara.state.area = Cascara.state.user.area;
    }
    // Para admins, si state.area no está set (refresh directo), usar la del usuario
    if (!Cascara.state.area && Cascara.state.user.area) {
      Cascara.state.area = Cascara.state.user.area;
    }
    // Sanity check final
    if (!Cascara.state.area) {
      console.warn('[CascaraForm] sin área asignada al usuario');
      alert('Tu usuario no tiene un área asignada en el sistema.');
      goTo('home');
      return;
    }

    // Cargar audit_status actual del quarter (puede haber cambiado en otra sesión)
    if (Cascara.state.quarter) {
      Cascara.state.quarter.audit_status = await Cascara.getAuditStatus();
    }

    // SOLO load — no create. Plan se crea on-demand cuando el director escribe algo.
    await Cascara.loadExistingPlan();

    // Marketing tiene un form distinto: documento estratégico del Q
    if (Cascara.state.area.slug === 'marketing' || Cascara.state.area.name?.toLowerCase().includes('marketing')) {
      return CascaraFormMarketing.enter();
    } else {
      // Asegurar que el form estándar esté visible (por si volvíamos de Marketing)
      CascaraFormMarketing.teardown?.();
    }

    // Renderizar banner contextual de audit_status
    this.renderAuditBanner();

    await this.populateFs1();
    await this.populateFs2();
    await this.populateFs4Plan();
    await this.populateFs5SingleFields();
    await this.populateFs6Notas();
    await this.renderProjects();
    await this.renderDependencies();
    await this.renderTeamMembers();
    await this.renderFortnights();
    this.showEmptyStateHint();

    if (!this.inited) {
      this.setupAutoSave();
      this.injectImportButtons();
      // Wire export buttons (idempotente — onclick reemplaza el anterior)
      const btnJson = document.getElementById('fg-btn-export-json');
      if (btnJson) btnJson.onclick = () => CascaraExport.downloadJSON();
      const btnPdf = document.getElementById('fg-btn-export-pdf');
      if (btnPdf) btnPdf.onclick = () => CascaraExport.printPDF();
      this.inited = true;
    }

    // Hookea los comentarios al final (despues de renderizar todo)
    // Solo si ya hay plan creado (sino no hay nada que comentar)
    if (Cascara.isAdmin() && Cascara.state.plan) {
      CascaraComments.attachToForm();
    }
  },

  // ---------- LAZY CREATE ----------
  async ensurePlanExists() {
    if (Cascara.state.plan) return Cascara.state.plan;
    // DEFENSIVO: nunca crear un plan para un area que no se identifica
    if (!Cascara.state.area || !Cascara.state.user) {
      console.error('[CascaraForm] No se puede crear plan sin area o user');
      return null;
    }
    // DEFENSIVO: para directores forzar siempre su área
    if (Cascara.state.user.role === 'director' &&
        Cascara.state.area.id !== Cascara.state.user.area?.id) {
      console.error('[CascaraForm] BLOQUEADO: director intentando crear plan para area distinta a la suya', {
        director_area: Cascara.state.user.area?.name,
        target_area: Cascara.state.area.name,
      });
      Cascara.state.area = Cascara.state.user.area;
    }
    const plan = await Cascara.getOrCreatePlan();
    if (plan) {
      this.removeEmptyStateHint();
      if (Cascara.isAdmin()) CascaraComments.attachToForm();
    }
    return plan;
  },

  updateForeignAreaBanner() {
    const existing = document.getElementById('cascara-foreign-banner');
    if (existing) existing.remove();
    if (!Cascara.isAdmin()) return;
    if (!Cascara.state.area || !Cascara.state.user) return;
    if (Cascara.state.area.id === Cascara.state.user.area?.id) return; // está en su propia área

    const banner = document.createElement('div');
    banner.id = 'cascara-foreign-banner';
    banner.style.cssText = 'background:rgba(195,154,0,0.16);border:1px solid rgba(195,154,0,0.35);color:#7A6000;padding:12px 18px;border-radius:12px;margin:0 0 24px;font-size:13px;line-height:1.5;display:flex;align-items:center;gap:12px;';
    banner.innerHTML = `
      <span style="font-size:18px;">⚠</span>
      <div style="flex:1;">
        <strong>Estás viendo el plan de ${Cascara.state.area.name}</strong> como Admin. Cualquier edición se guarda en el plan de esa área, no en el tuyo. Para volver a tu plan, andá al home.
      </div>
    `;
    const form = document.querySelector('#view-formulario .formulario-grid, #view-formulario .f-section');
    if (form && form.parentElement) form.parentElement.insertBefore(banner, form);
  },

  // ---------- AUDIT BANNER · indica qué capa está abierta ----------
  renderAuditBanner() {
    const existing = document.getElementById('cascara-audit-banner');
    if (existing) existing.remove();

    const status = Cascara.state.quarter?.audit_status || 'planning';
    const isOpen = Cascara.isCapa2Open(status);

    // Inyectar CSS para el gating si no está
    if (!document.getElementById('cascara-gating-style')) {
      const style = document.createElement('style');
      style.id = 'cascara-gating-style';
      style.textContent = `
        /* Campos bloqueados en Capa 1 */
        .cascara-capa2-locked {
          background: rgba(0,0,0,0.04) !important;
          color: var(--ink-faint) !important;
          cursor: not-allowed !important;
          pointer-events: none;
          opacity: 0.6;
        }
        /* Sección entera bloqueada (fs6 Ritmo) */
        #fs6.cascara-section-locked {
          position: relative;
          opacity: 0.55;
          pointer-events: none;
        }
        #fs6.cascara-section-locked::before {
          content: '🔒 Esta sección se desbloquea después de la Audit Session del Strategy Council';
          position: absolute;
          top: 50%; left: 50%;
          transform: translate(-50%, -50%);
          background: rgba(195,154,0,0.95);
          color: #fff;
          padding: 14px 24px;
          border-radius: 999px;
          font-size: 13px;
          font-weight: 700;
          letter-spacing: 0.02em;
          z-index: 10;
          pointer-events: auto;
          cursor: not-allowed;
          box-shadow: 0 10px 30px rgba(0,0,0,0.18);
        }
        /* Banner contextual arriba del form */
        #cascara-audit-banner {
          margin: 0 0 24px;
          padding: 16px 20px;
          border-radius: 12px;
          font-size: 13.5px;
          line-height: 1.5;
          display: flex; align-items: flex-start; gap: 14px;
        }
        #cascara-audit-banner.is-capa1 {
          background: rgba(195,154,0,0.08);
          border: 1px solid rgba(195,154,0,0.3);
          color: #7A6000;
        }
        #cascara-audit-banner.is-capa2 {
          background: rgba(0,179,107,0.07);
          border: 1px solid rgba(0,179,107,0.28);
          color: #00733C;
        }
        #cascara-audit-banner .ab-icon { font-size: 18px; line-height: 1; flex-shrink: 0; }
        #cascara-audit-banner strong { display: block; margin-bottom: 4px; }
      `;
      document.head.appendChild(style);
    }

    const banner = document.createElement('div');
    banner.id = 'cascara-audit-banner';
    if (isOpen) {
      banner.className = 'is-capa2';
      banner.innerHTML = `
        <span class="ab-icon">✓</span>
        <div>
          <strong>Capa 2 abierta</strong>
          El Master Timeline está locked. Completá las fechas de Hitos y KPIs, y el Ritmo del Q se va a auto-poblar.
        </div>
      `;
    } else if (status === 'audit_in_progress') {
      banner.className = 'is-capa1';
      banner.innerHTML = `
        <span class="ab-icon">⏳</span>
        <div>
          <strong>Audit Session en curso</strong>
          El Strategy Council (Teo + Facu + Franco) está ordenando los Proyectos en el Master Timeline. Los campos de fecha se desbloquean cuando termine.
        </div>
      `;
    } else {
      banner.className = 'is-capa1';
      banner.innerHTML = `
        <span class="ab-icon">🟡</span>
        <div>
          <strong>Capa 1 — En planificación</strong>
          Cargá el QUÉ y el POR QUÉ de tus Proyectos. Las fechas de Hitos y el Ritmo del Q se completan después del Audit Session del Strategy Council.
        </div>
      `;
    }
    const formGrid = document.querySelector('#view-formulario .formulario-grid, #view-formulario .f-section');
    if (formGrid?.parentElement) formGrid.parentElement.insertBefore(banner, formGrid);

    // Aplicar gating al fs6 según estado
    const fs6 = document.getElementById('fs6');
    if (fs6) {
      fs6.classList.toggle('cascara-section-locked', !isOpen);
    }
    // Aplicar gating a los date inputs (kpi deadline + milestone due_date)
    this.applyDateGating(isOpen);
  },

  applyDateGating(capa2Open) {
    document.querySelectorAll('.f-kpi-row input[data-field="deadline"], .f-milestone-row input[data-field="due_date"]').forEach(el => {
      if (capa2Open) {
        el.classList.remove('cascara-capa2-locked');
        el.disabled = false;
        el.title = '';
      } else {
        el.classList.add('cascara-capa2-locked');
        el.disabled = true;
        el.title = 'Se completa después del Audit Session del Strategy Council';
      }
    });
  },

  showEmptyStateHint() {
    if (Cascara.state.plan) { this.removeEmptyStateHint(); return; }
    let hint = document.getElementById('cascara-empty-hint');
    if (hint) return;
    hint = document.createElement('div');
    hint.id = 'cascara-empty-hint';
    hint.style.cssText = 'background:rgba(16,6,159,0.06);border:1px dashed rgba(16,6,159,0.25);color:#10069F;padding:14px 18px;border-radius:12px;margin:0 0 28px;font-size:13px;line-height:1.5;';
    hint.innerHTML = '<strong>Plan en blanco.</strong> Empezá a escribir o agregá tu primer Proyecto. Se va a guardar automáticamente.';
    const form = document.querySelector('#view-formulario .formulario-grid, #view-formulario .f-section');
    if (form && form.parentElement) form.parentElement.insertBefore(hint, form);
  },
  removeEmptyStateHint() {
    const h = document.getElementById('cascara-empty-hint');
    if (h) h.remove();
  },

  // ---------- fs1 IDENTIDAD (readonly · solo fecha editable) ----------
  async populateFs1() {
    const plan = Cascara.state.plan;
    const area = Cascara.state.area;
    const user = Cascara.state.user;
    const quarter = Cascara.state.quarter;

    const fArea = document.getElementById('f-area');
    if (fArea && area) fArea.value = area.name;

    // Director correcto: el director del área
    const fDirector = document.getElementById('f-director');
    if (fDirector && area) {
      const { data: areaDirector } = await Cascara.client.from('users')
        .select('name').eq('area_id', area.id).eq('role', 'director').maybeSingle();
      if (areaDirector) {
        fDirector.value = areaDirector.name;
      } else if (user && area.id === user.area?.id) {
        fDirector.value = user.name;
      } else {
        fDirector.value = '';
      }
    }

    const fTrim = document.getElementById('f-trimestre');
    if (fTrim && quarter) fTrim.value = quarter.name;

    const fFecha = document.getElementById('f-fecha');
    if (fFecha) {
      fFecha.value = plan?.presentation_date ? this.formatDate(plan.presentation_date) : '';
      fFecha.setAttribute('data-field', 'presentation_date');
      fFecha.setAttribute('data-target', 'plan');
    }

    this.updateForeignAreaBanner();
  },

  // ---------- fs2 CONTEXTO DEL Q (visión + aprendizajes + no-goals) ----------
  async populateFs2() {
    const plan = Cascara.state.plan;
    const fs2 = document.getElementById('fs2');
    if (!fs2) return;
    const textareas = fs2.querySelectorAll('.f-textarea');
    const fields = ['vision_text', 'q_learnings', 'q_non_goals'];
    fields.forEach((field, i) => {
      const t = textareas[i];
      if (!t) return;
      t.value = plan?.[field] || '';
      t.setAttribute('data-field', field);
      t.setAttribute('data-target', 'plan');
    });
  },

  // ---------- fs4 NEEDS FROM LEADERSHIP ----------
  async populateFs4Plan() {
    const plan = Cascara.state.plan;
    const fs4 = document.getElementById('fs4');
    if (!fs4) return;
    // El último textarea de fs4 es needs_from_leadership
    const lbl = Array.from(fs4.querySelectorAll('.f-field-label'))
      .find(l => l.textContent.trim().toLowerCase().startsWith('qué necesito del'));
    const textarea = lbl?.parentElement?.querySelector('.f-textarea');
    if (textarea) {
      textarea.value = plan?.needs_from_leadership || '';
      textarea.setAttribute('data-field', 'needs_from_leadership');
      textarea.setAttribute('data-target', 'plan');
    }
  },

  // ---------- fs5 SINGLE FIELDS ----------
  async populateFs5SingleFields() {
    const plan = Cascara.state.plan;
    const fs5 = document.getElementById('fs5');
    if (!fs5) return;

    const findFieldByLabel = (text, selector) => {
      const lbl = Array.from(fs5.querySelectorAll('.f-field-label'))
        .find(l => l.textContent.trim().toLowerCase().startsWith(text.toLowerCase()));
      return lbl?.parentElement?.querySelector(selector);
    };

    const presup = findFieldByLabel('Presupuesto del Q', '.f-input');
    if (presup) {
      presup.value = plan?.presupuesto || '';
      presup.setAttribute('data-field', 'presupuesto');
      presup.setAttribute('data-target', 'plan');
    }

    const incorp = findFieldByLabel('Incorporaciones previstas', '.f-input');
    if (incorp) {
      incorp.value = plan?.incorporaciones || '';
      incorp.setAttribute('data-field', 'incorporaciones');
      incorp.setAttribute('data-target', 'plan');
    }

    const herram = findFieldByLabel('Herramientas y servicios externos', '.f-textarea');
    if (herram) {
      herram.value = plan?.herramientas || '';
      herram.setAttribute('data-field', 'herramientas');
      herram.setAttribute('data-target', 'plan');
    }
  },

  // Notas para el CEO ahora viven en fs6 (Ritmo del Q)
  async populateFs6Notas() {
    const plan = Cascara.state.plan;
    const fs6 = document.getElementById('fs6');
    if (!fs6) return;
    const notasLbl = Array.from(fs6.querySelectorAll('.f-field-label'))
      .find(l => l.textContent.trim().toLowerCase().startsWith('notas adicionales'));
    const notasTextarea = notasLbl?.parentElement?.querySelector('.f-textarea');
    if (notasTextarea) {
      notasTextarea.value = plan?.notas_ceo || '';
      notasTextarea.setAttribute('data-field', 'notas_ceo');
      notasTextarea.setAttribute('data-target', 'plan');
    }
  },

  // ---------- fs3 PROJECTS ----------
  async renderProjects() {
    const fs3 = document.getElementById('fs3');
    if (!fs3) return;
    const list = fs3.querySelector('.f-resp-list');
    if (!list) return;

    // Limpiar siempre los items hardcodeados del demo
    list.querySelectorAll('.f-resp-item').forEach(el => el.remove());
    let addBtn = list.querySelector('.f-resp-add');

    // Solo cargamos proyectos si ya existe un plan en DB (no creamos nada por default)
    const projects = Cascara.state.plan ? await Cascara.listProjects() : [];

    projects.forEach((p, idx) => {
      const el = this.buildProjectElement(p, idx);
      list.insertBefore(el, addBtn);
    });

    if (addBtn) {
      addBtn.onclick = async (e) => {
        e.preventDefault();
        await this.ensurePlanExists();
        const p = await Cascara.createProject(Cascara.state.plan.id);
        const newEl = this.buildProjectElement({ ...p, kpis: [] }, list.querySelectorAll('.f-resp-item').length);
        list.insertBefore(newEl, addBtn);
        if (Cascara.isAdmin()) CascaraComments.attachToForm();
      };
    }
  },

  buildProjectElement(project, idx) {
    const num = String(idx + 1).padStart(2, '0');
    const el = document.createElement('div');
    el.className = 'f-resp-item';
    el.dataset.projectId = project.id;
    el.innerHTML = `
      <div class="f-resp-item-head">
        <span class="f-resp-item-num">${num}</span>
        <div class="f-resp-item-name">
          <input type="text" placeholder="Nombre del proyecto" data-target="project" data-field="name" />
        </div>
        <button class="f-resp-remove" title="Eliminar proyecto" style="background:none;border:none;color:#A8A8AC;font-size:18px;cursor:pointer;padding:0 8px;">×</button>
      </div>
      <div class="f-resp-body">
        <div class="f-field-row">
          <div class="f-field">
            <div class="f-field-label">Responsable <span class="required">obligatorio</span></div>
            <div class="f-field-help">Team member 100% accountable de que este Proyecto avance.</div>
            <input type="text" class="f-input" placeholder="Nombre del responsable" data-target="project" data-field="responsible_name" />
          </div>
          <div class="f-field">
            <div class="f-field-label">Subresponsables</div>
            <div class="f-field-help">Otros team members que participan pero no son owners.</div>
            <input type="text" class="f-input" placeholder="Nombres separados por coma" data-target="project" data-field="subresponsables" />
          </div>
        </div>
        <div class="f-field">
          <div class="f-field-label">Alcance y ejecución <span class="required">obligatorio</span></div>
          <div class="f-field-help">Qué cubre este Proyecto y cómo se va a llevar adelante este Q.</div>
          <textarea class="f-textarea" placeholder="Este Proyecto cubre... Para ejecutarlo vamos a..." data-target="project" data-field="scope_execution"></textarea>
        </div>
        <div class="f-field-row">
          <div class="f-field">
            <div class="f-field-label">Hipótesis <span class="required">obligatorio</span></div>
            <div class="f-field-help">Qué creemos que va a pasar si ejecutamos bien.</div>
            <textarea class="f-textarea" placeholder="Si hacemos X, entonces Y..." data-target="project" data-field="hypothesis"></textarea>
          </div>
          <div class="f-field">
            <div class="f-field-label">Objetivo puntual del Q <span class="required">obligatorio</span></div>
            <div class="f-field-help">Meta concreta y medible para el trimestre.</div>
            <textarea class="f-textarea" placeholder="Al cierre del Q, lograr..." data-target="project" data-field="objective"></textarea>
          </div>
        </div>
        <div class="f-field-row">
          <div class="f-field">
            <div class="f-field-label">Por qué es prioridad <span class="required">obligatorio</span></div>
            <div class="f-field-help">Fundamento de por qué se eligió este sobre otros.</div>
            <textarea class="f-textarea" placeholder="Este proyecto es prioritario porque..." data-target="project" data-field="why_priority"></textarea>
          </div>
          <div class="f-field">
            <div class="f-field-label">Impacto a nivel negocio <span class="required">obligatorio</span></div>
            <div class="f-field-help">Qué cambia en el negocio si lo logramos.</div>
            <textarea class="f-textarea" placeholder="Lograr esto va a impactar el negocio en..." data-target="project" data-field="business_impact"></textarea>
          </div>
        </div>
        <div class="f-field">
          <div class="f-field-label">Riesgos del proyecto</div>
          <div class="f-field-help">Una línea con lo que podría fallar. Lo vamos a mirar en cada check-in.</div>
          <input type="text" class="f-input" placeholder="El riesgo principal es..." data-target="project" data-field="risks" />
        </div>
        <div class="f-field f-milestones-list">
          <div class="f-field-label">Hitos del Proyecto</div>
          <div class="f-field-help"><strong>Cargá ahora el título</strong> de cada hito (qué momento clave del proyecto). <strong>La fecha</strong> se completa <strong>después del Audit Session</strong>, basándote en el Master Timeline del Q. Los hitos con fecha se ven en el Ritmo del Q.</div>
          <div class="f-milestones-rows"></div>
          <button class="f-milestone-add" type="button">+ agregar hito</button>
        </div>
        <div class="f-field f-kpi-list">
          <div class="f-field-label">KPIs comprometidos <span class="required">obligatorio</span></div>
          <div class="f-field-help"><strong>Cargá los KPIs que sostengan este Proyecto. Cantidad ilimitada</strong> — no hay mínimo ni máximo. Cada uno con nombre + número objetivo. <strong>La fecha de cumplimiento</strong> se completa <strong>después del Audit Session</strong>, cuando sepas en qué quincena del Q vive el proyecto.</div>
          <div class="f-kpi-rows"></div>
          <button class="f-kpi-add" type="button">+ agregar KPI</button>
        </div>
      </div>
    `;

    // Set values
    el.querySelector('[data-field="name"]').value = project.name || '';
    el.querySelector('[data-field="responsible_name"]').value = project.responsible_name || '';
    el.querySelector('[data-field="subresponsables"]').value = project.subresponsables || '';
    el.querySelector('[data-field="scope_execution"]').value = project.scope_execution || '';
    el.querySelector('[data-field="hypothesis"]').value = project.hypothesis || '';
    el.querySelector('[data-field="objective"]').value = project.objective || '';
    el.querySelector('[data-field="why_priority"]').value = project.why_priority || '';
    el.querySelector('[data-field="business_impact"]').value = project.business_impact || '';
    el.querySelector('[data-field="risks"]').value = project.risks || '';

    // Remove button
    el.querySelector('.f-resp-remove').onclick = async (e) => {
      e.preventDefault();
      if (!confirm('¿Eliminar este proyecto?')) return;
      await Cascara.deleteProject(project.id);
      el.remove();
    };

    // KPIs
    const kpiRows = el.querySelector('.f-kpi-rows');
    (project.kpis || []).forEach(k => kpiRows.appendChild(this.buildKpiRow(k)));
    el.querySelector('.f-kpi-add').onclick = async (e) => {
      e.preventDefault();
      const k = await Cascara.createKpi(project.id);
      kpiRows.appendChild(this.buildKpiRow(k));
    };

    // Milestones — async load
    const msRows = el.querySelector('.f-milestones-rows');
    Cascara.listProjectMilestones(project.id).then(milestones => {
      (milestones || []).forEach(m => msRows.appendChild(this.buildMilestoneRow(m)));
    });
    el.querySelector('.f-milestone-add').onclick = async (e) => {
      e.preventDefault();
      const m = await Cascara.createMilestone(project.id);
      msRows.appendChild(this.buildMilestoneRow(m));
    };

    return el;
  },

  buildMilestoneRow(m) {
    const row = document.createElement('div');
    row.className = 'f-milestone-row';
    row.dataset.milestoneId = m.id;
    row.style.cssText = 'display:grid;grid-template-columns: 30px 1fr 130px 30px;gap:8px;align-items:center;margin-bottom:6px;';
    const checked = m.status === 'done';
    const capa2 = Cascara.isCapa2Open(Cascara.state.quarter?.audit_status);
    row.innerHTML = `
      <button class="f-ms-toggle" type="button" title="Marcar como completado" style="width:22px;height:22px;border-radius:5px;border:1.5px solid ${checked ? '#00B36B' : 'rgba(0,0,0,0.18)'};background:${checked ? '#00B36B' : 'transparent'};color:white;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;">${checked ? '✓' : ''}</button>
      <input type="text" class="f-input" placeholder="Qué tiene que estar listo" data-target="milestone" data-field="title" />
      <input type="date" class="f-input ${capa2 ? '' : 'cascara-capa2-locked'}" data-target="milestone" data-field="due_date" ${capa2 ? '' : 'disabled title="Se completa después del Audit Session"'} />
      <button class="f-ms-remove" type="button" style="background:none;border:none;color:#A8A8AC;font-size:18px;cursor:pointer;padding:0;">×</button>
    `;
    row.querySelector('[data-field="title"]').value = m.title || '';
    row.querySelector('[data-field="due_date"]').value = m.due_date || '';
    if (checked) row.querySelector('[data-field="title"]').style.textDecoration = 'line-through';

    row.querySelector('.f-ms-toggle').onclick = async (e) => {
      e.preventDefault();
      const newStatus = await Cascara.toggleMilestoneStatus(m.id, m.status);
      m.status = newStatus;
      const btn = row.querySelector('.f-ms-toggle');
      const titleInput = row.querySelector('[data-field="title"]');
      if (newStatus === 'done') {
        btn.style.background = '#00B36B'; btn.style.borderColor = '#00B36B'; btn.textContent = '✓';
        titleInput.style.textDecoration = 'line-through';
      } else {
        btn.style.background = 'transparent'; btn.style.borderColor = 'rgba(0,0,0,0.18)'; btn.textContent = '';
        titleInput.style.textDecoration = 'none';
      }
    };
    row.querySelector('.f-ms-remove').onclick = async (e) => {
      e.preventDefault();
      await Cascara.deleteMilestone(m.id);
      row.remove();
    };
    return row;
  },

  buildKpiRow(kpi) {
    const row = document.createElement('div');
    row.className = 'f-kpi-row';
    row.dataset.kpiId = kpi.id;
    const capa2 = Cascara.isCapa2Open(Cascara.state.quarter?.audit_status);
    row.innerHTML = `
      <input type="text" class="f-input" placeholder="Nombre del KPI" data-target="kpi" data-field="name" />
      <input type="text" class="f-input" placeholder="N° objetivo (ej: 100 o 20%)" data-target="kpi" data-field="target" inputmode="numeric" />
      <input type="date" class="f-input ${capa2 ? '' : 'cascara-capa2-locked'}" data-target="kpi" data-field="deadline" ${capa2 ? '' : 'disabled title="Se completa después del Audit Session"'} />
      <button class="f-kpi-remove" type="button">×</button>
    `;
    row.querySelector('[data-field="name"]').value = kpi.name || '';
    row.querySelector('[data-field="target"]').value = kpi.target || '';
    row.querySelector('[data-field="deadline"]').value = kpi.deadline || '';
    row.querySelector('.f-kpi-remove').onclick = async (e) => {
      e.preventDefault();
      await Cascara.deleteKpi(kpi.id);
      row.remove();
    };
    return row;
  },

  // ---------- fs5 TEAM MEMBERS ----------
  async renderTeamMembers() {
    const fs5 = document.getElementById('fs5');
    if (!fs5) return;
    const container = fs5.querySelector('.f-field');
    if (!container) return;

    // Buscar/limpiar la lista existente (incluyendo demos hardcodeados)
    fs5.querySelectorAll('.f-team-member, .f-team-row').forEach(el => {
      if (el.closest('.f-field-row')) return;
      el.remove();
    });
    let addBtn = fs5.querySelector('.f-field > .f-kpi-add');
    if (!addBtn) {
      addBtn = document.createElement('button');
      addBtn.className = 'f-kpi-add';
      addBtn.type = 'button';
      addBtn.textContent = '+ agregar integrante';
      container.appendChild(addBtn);
    }

    // Solo cargamos si hay plan en DB
    const members = Cascara.state.plan ? await Cascara.listTeamMembers() : [];
    members.forEach(m => addBtn.parentNode.insertBefore(this.buildTeamMemberElement(m), addBtn));

    addBtn.onclick = async (e) => {
      e.preventDefault();
      await this.ensurePlanExists();
      const m = await Cascara.createTeamMember(Cascara.state.plan.id);
      addBtn.parentNode.insertBefore(this.buildTeamMemberElement(m), addBtn);
    };
  },

  buildTeamMemberElement(m) {
    const el = document.createElement('div');
    el.className = 'f-team-member';
    el.dataset.memberId = m.id;
    el.innerHTML = `
      <div class="f-team-row">
        <input type="text" class="f-input" placeholder="Nombre" data-target="team_member" data-field="name" />
        <input type="text" class="f-input" placeholder="Rol" data-target="team_member" data-field="role" />
        <input type="text" class="f-input" placeholder="Dedicación" data-target="team_member" data-field="dedication" />
        <input type="text" class="f-input" placeholder="Estado" data-target="team_member" data-field="status" />
        <button class="f-kpi-remove" type="button">×</button>
      </div>
      <div class="f-field f-team-goal">
        <div class="f-field-label">Goal personal</div>
        <div class="f-field-help">El goal puntual de esta persona para el Q. Puede colaborar en otras responsabilidades, pero esta es la suya.</div>
        <textarea class="f-textarea" placeholder="Cuál es el goal de esta persona en el Q..." data-target="team_member" data-field="goal"></textarea>
      </div>
    `;
    el.querySelector('[data-field="name"]').value = m.name || '';
    el.querySelector('[data-field="role"]').value = m.role || '';
    el.querySelector('[data-field="dedication"]').value = m.dedication || '';
    el.querySelector('[data-field="status"]').value = m.status || '';
    el.querySelector('[data-field="goal"]').value = m.goal || '';
    el.querySelector('.f-kpi-remove').onclick = async (e) => {
      e.preventDefault();
      if (!confirm('¿Eliminar este integrante?')) return;
      await Cascara.deleteTeamMember(m.id);
      el.remove();
    };
    return el;
  },

  // ---------- fs4 DEPENDENCIAS (lista libre) ----------
  async renderDependencies() {
    const fs4 = document.getElementById('fs4');
    if (!fs4) return;
    const list = fs4.querySelector('.f-deps-list');
    if (!list) return;

    const myArea = Cascara.state.area;
    const { data: areas } = await Cascara.client.from('areas').select('*').order('order_index');
    const others = (areas || []).filter(a => a.id !== myArea?.id);

    // Limpiar entradas anteriores
    list.querySelectorAll('.f-dep-card').forEach(el => el.remove());
    let addBtn = list.querySelector('.f-dep-add');
    if (!addBtn) {
      addBtn = document.createElement('button');
      addBtn.className = 'f-dep-add';
      addBtn.type = 'button';
      addBtn.textContent = '+ agregar dependencia';
      list.appendChild(addBtn);
    }

    const existing = Cascara.state.plan ? await Cascara.listArticulations() : [];
    existing.forEach(dep => list.insertBefore(this.buildDependencyCard(dep, others), addBtn));

    addBtn.onclick = async (e) => {
      e.preventDefault();
      await this.ensurePlanExists();
      // Crear con primer area disponible como default
      const firstArea = others[0];
      if (!firstArea) return;
      const id = await Cascara.upsertArticulation(Cascara.state.plan.id, firstArea.id, { what_delivers: '', what_needs: '' });
      // Reload data
      const existing = await Cascara.listArticulations();
      const fresh = existing.find(d => d.id === id) || { id, with_area_id: firstArea.id, what_delivers: '', what_needs: '' };
      list.insertBefore(this.buildDependencyCard(fresh, others), addBtn);
    };
  },
  buildDependencyCard(dep, otherAreas) {
    const card = document.createElement('div');
    card.className = 'f-dep-card f-art-card';
    card.dataset.depId = dep.id;
    card.dataset.withAreaId = dep.with_area_id || '';
    const areaName = dep.with_area?.name || otherAreas.find(a => a.id === dep.with_area_id)?.name || '';
    const areaColor = dep.with_area?.color || otherAreas.find(a => a.id === dep.with_area_id)?.color || '#10069F';
    card.innerHTML = `
      <div class="f-art-area" style="display:flex;align-items:center;justify-content:space-between;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="dot" style="background:${areaColor};width:8px;height:8px;border-radius:50%;display:inline-block;"></span>
          <select class="f-area-select" style="background:transparent;border:none;font-weight:700;font-size:14px;color:#0A0A0C;cursor:pointer;padding:2px 4px;">
            ${otherAreas.map(a => `<option value="${a.id}" ${a.id === dep.with_area_id ? 'selected' : ''}>Con ${a.name}</option>`).join('')}
          </select>
        </div>
        <button class="f-dep-remove" type="button" style="background:none;border:none;color:#A8A8AC;font-size:18px;cursor:pointer;padding:0 4px;">×</button>
      </div>
      <div class="f-field">
        <div class="f-field-label">Qué necesitás de ellos</div>
        <textarea class="f-textarea" placeholder="..." data-target="articulation" data-field="what_needs"></textarea>
      </div>
      <div class="f-field">
        <div class="f-field-label">Qué les entregás</div>
        <textarea class="f-textarea" placeholder="..." data-target="articulation" data-field="what_delivers"></textarea>
      </div>
    `;
    card.querySelector('[data-field="what_delivers"]').value = dep.what_delivers || '';
    card.querySelector('[data-field="what_needs"]').value = dep.what_needs || '';
    card.querySelector('.f-area-select').onchange = async (e) => {
      const newAreaId = e.target.value;
      card.dataset.withAreaId = newAreaId;
      // Re-upsert with new area
      const current = {
        what_delivers: card.querySelector('[data-field="what_delivers"]').value,
        what_needs: card.querySelector('[data-field="what_needs"]').value,
      };
      await Cascara.upsertArticulation(Cascara.state.plan.id, newAreaId, current);
    };
    card.querySelector('.f-dep-remove').onclick = async (e) => {
      e.preventDefault();
      if (!confirm('¿Eliminar esta dependencia?')) return;
      if (dep.id) await Cascara.client.from('articulations').delete().eq('id', dep.id);
      card.remove();
    };
    return card;
  },

  // ---------- DEPRECATED fs6 IMPROVEMENTS (mejoras ahora son Proyectos) ----------
  async _deprecated_renderImprovements() {
    const fs6 = document.getElementById('fs6');
    if (!fs6) return;

    // Remover cards hardcodeadas del demo
    fs6.querySelectorAll('.f-mejora-card').forEach(c => c.remove());
    let addBtn = fs6.querySelector('.f-resp-add');
    if (!addBtn) {
      addBtn = document.createElement('button');
      addBtn.className = 'f-resp-add';
      addBtn.type = 'button';
      addBtn.textContent = '+ agregar mejora (máximo 3)';
      fs6.appendChild(addBtn);
    }

    const items = Cascara.state.plan ? await Cascara.listImprovements() : [];
    items.forEach((it, idx) => {
      fs6.insertBefore(this.buildImprovementElement(it, idx), addBtn);
    });

    addBtn.onclick = async (e) => {
      e.preventDefault();
      const currentCount = fs6.querySelectorAll('.f-mejora-card').length;
      if (currentCount >= 3) {
        alert('Máximo 3 mejoras por trimestre.');
        return;
      }
      await this.ensurePlanExists();
      const m = await Cascara.createImprovement(Cascara.state.plan.id);
      fs6.insertBefore(this.buildImprovementElement(m, currentCount), addBtn);
    };
  },
  buildImprovementElement(item, idx) {
    const num = String(idx + 1).padStart(2, '0');
    const el = document.createElement('div');
    el.className = 'f-mejora-card';
    el.dataset.improvementId = item.id;
    el.innerHTML = `
      <div class="f-mejora-head">
        <span class="f-mejora-num">${num}</span>
        <div class="f-field-label" style="margin:0; flex:1;">Mejora ${num}</div>
        <button class="f-imp-remove" type="button" style="background:none;border:none;color:#A8A8AC;font-size:18px;cursor:pointer;">×</button>
      </div>
      <div class="f-field">
        <div class="f-field-label">Qué se va a mejorar</div>
        <input type="text" class="f-input" placeholder="Describí la mejora..." data-target="improvement" data-field="what_improve" />
      </div>
      <div class="f-mejora-fields">
        <div>
          <div class="f-field-label">Responsable</div>
          <input type="text" class="f-input" data-target="improvement" data-field="responsible" />
        </div>
        <div>
          <div class="f-field-label">Fecha objetivo</div>
          <input type="text" class="f-input" data-target="improvement" data-field="target_date" />
        </div>
      </div>
    `;
    el.querySelector('[data-field="what_improve"]').value = item.what_improve || '';
    el.querySelector('[data-field="responsible"]').value = item.responsible || '';
    el.querySelector('[data-field="target_date"]').value = item.target_date || '';
    el.querySelector('.f-imp-remove').onclick = async (e) => {
      e.preventDefault();
      if (!confirm('¿Eliminar esta mejora?')) return;
      await Cascara.deleteImprovement(item.id);
      el.remove();
    };
    return el;
  },

  // ---------- fs6 RITMO DEL Q (6 quincenas) ----------
  async renderFortnights() {
    const fs6 = document.getElementById('fs6');
    if (!fs6) return;
    const grid = fs6.querySelector('.f-fortnight-grid');
    if (!grid) return;

    const existing = Cascara.state.plan ? await Cascara.listCalendarMonths() : [];
    const byIndex = new Map(existing.map(m => [m.order_index, m]));

    const fortnights = this.deriveFortnightsFromQuarter(Cascara.state.quarter);

    // Pre-fetch all milestones for the area's projects (for auto-display)
    let milestonesByFortnight = new Map();
    if (Cascara.state.plan) {
      const projects = await Cascara.listProjects();
      const allMilestones = [];
      for (const p of projects) {
        const ms = await Cascara.listProjectMilestones(p.id);
        ms.forEach(m => { if (m.due_date) allMilestones.push({ ...m, project_name: p.name }); });
      }
      allMilestones.forEach(m => {
        const idx = this.fortnightIndexForDate(m.due_date, Cascara.state.quarter);
        if (idx) {
          if (!milestonesByFortnight.has(idx)) milestonesByFortnight.set(idx, []);
          milestonesByFortnight.get(idx).push(m);
        }
      });
    }

    grid.innerHTML = '';
    fortnights.forEach((fn, i) => {
      const orderIndex = i + 1;
      const ex = byIndex.get(orderIndex) || {};
      const fortMs = milestonesByFortnight.get(orderIndex) || [];
      const card = document.createElement('div');
      card.className = 'f-fortnight-card';
      card.dataset.orderIndex = orderIndex;
      card.dataset.monthLabel = fn.label;
      card.style.cssText = 'background:rgba(255,255,255,0.42);border:1px solid rgba(0,0,0,0.07);border-radius:14px;padding:18px;margin-bottom:14px;';
      card.innerHTML = `
        <div class="f-month-tag" style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
          <span class="f-month-num" style="background:rgba(16,6,159,0.08);color:#10069F;font-weight:700;font-size:11px;padding:3px 10px;border-radius:999px;letter-spacing:0.05em;">${String(orderIndex).padStart(2,'0')}</span>
          <span class="f-month-name" style="font-weight:700;font-size:14.5px;">${fn.label}</span>
          <span style="margin-left:auto;font-size:11.5px;color:#52525A;font-family:'Redaction',Georgia,serif;font-style:italic;">${fn.dateLabel}</span>
        </div>
        <div class="f-field">
          <div class="f-field-help" style="margin-bottom:6px;">Qué tiene que estar pasando o listo a esta altura.</div>
          <textarea class="f-textarea" placeholder="A esta altura del Q..." data-target="calendar_month" data-field="milestones"></textarea>
        </div>
        ${fortMs.length > 0 ? `
          <div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(0,0,0,0.06);">
            <div style="font-size:10.5px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:#10069F;margin-bottom:6px;">Hitos de Proyectos en esta quincena</div>
            ${fortMs.map(m => `
              <div style="font-size:12px;color:#0A0A0C;margin-bottom:3px;">
                <span style="color:${m.status === 'done' ? '#00B36B' : '#52525A'};">${m.status === 'done' ? '✓' : '○'}</span>
                <strong>${m.due_date}</strong> · ${this.escapeHtml(m.title || '—')} <span style="color:#52525A;">(${this.escapeHtml(m.project_name || 'Proyecto')})</span>
              </div>
            `).join('')}
          </div>
        ` : ''}
      `;
      card.querySelector('[data-field="milestones"]').value = ex.milestones || '';
      grid.appendChild(card);
    });
  },
  deriveFortnightsFromQuarter(quarter) {
    const labels = ['Apertura', 'Producción 01', 'Punto medio', 'Producción 02', 'Push final', 'Cierre'];
    if (!quarter) {
      return labels.map((l, i) => ({ label: `Quincena ${String(i+1).padStart(2,'0')} · ${l}`, dateLabel: '—' }));
    }
    const start = new Date(quarter.start_date);
    return labels.map((l, i) => {
      const startDate = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i * 14);
      const endDate = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i * 14 + 13);
      const fmt = d => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
      return {
        label: `Quincena ${String(i+1).padStart(2,'0')} · ${l}`,
        dateLabel: `${fmt(startDate)} → ${fmt(endDate)}`,
        startDate, endDate,
      };
    });
  },
  fortnightIndexForDate(dateStr, quarter) {
    if (!dateStr || !quarter) return null;
    const d = new Date(dateStr);
    const start = new Date(quarter.start_date);
    const daysDiff = Math.floor((d - start) / (1000 * 60 * 60 * 24));
    const idx = Math.floor(daysDiff / 14) + 1;
    return (idx >= 1 && idx <= 6) ? idx : null;
  },
  escapeHtml(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  },

  // ---------- AUTO SAVE ----------
  setupAutoSave() {
    const view = this.formView;
    if (!view) return;
    view.addEventListener('input', (e) => this.handleInput(e));
    view.addEventListener('change', (e) => this.handleInput(e));
  },

  handleInput(e) {
    const el = e.target;
    const field = el.getAttribute('data-field');
    const target = el.getAttribute('data-target');
    if (!field || !target) return;

    const value = el.value;
    const key = `${target}:${field}:${el.closest('[data-project-id], [data-member-id], [data-kpi-id]')?.dataset?.projectId || el.closest('[data-member-id]')?.dataset?.memberId || el.closest('[data-kpi-id]')?.dataset?.kpiId || ''}`;

    Cascara.debouncedSave(key, async () => {
      // Lazy create: el plan se crea recién cuando hay primera interacción
      await this.ensurePlanExists();
      if (!Cascara.state.plan) return;

      if (target === 'plan') {
        await Cascara.updatePlanField(field, value);
      } else if (target === 'project') {
        const pid = el.closest('.f-resp-item')?.dataset?.projectId;
        if (pid) await Cascara.updateProjectField(pid, field, value);
      } else if (target === 'team_member') {
        const mid = el.closest('.f-team-member')?.dataset?.memberId;
        if (mid) await Cascara.updateTeamMemberField(mid, field, value);
      } else if (target === 'kpi') {
        const kid = el.closest('.f-kpi-row')?.dataset?.kpiId;
        if (kid) await Cascara.updateKpiField(kid, field, value);
      } else if (target === 'articulation') {
        const card = el.closest('.f-art-card');
        const withAreaId = card?.dataset?.withAreaId;
        if (withAreaId) {
          const others = {
            what_delivers: card.querySelector('[data-field="what_delivers"]')?.value || '',
            what_needs: card.querySelector('[data-field="what_needs"]')?.value || '',
          };
          await Cascara.upsertArticulation(Cascara.state.plan.id, withAreaId, others);
        }
      } else if (target === 'milestone') {
        const mid = el.closest('.f-milestone-row')?.dataset?.milestoneId;
        if (mid) await Cascara.updateMilestoneField(mid, field, value);
      } else if (target === 'calendar_month') {
        const card = el.closest('.f-month-card');
        const orderIndex = parseInt(card?.dataset?.orderIndex);
        const monthLabel = card?.dataset?.monthLabel;
        if (orderIndex) await Cascara.upsertCalendarMonth(Cascara.state.plan.id, monthLabel, orderIndex, value);
      }
    });
  },

  // ---------- IMPORT BUTTONS ----------
  injectImportButtons() {
    const map = [
      { sectionId: 'fs2', section: 'vision', label: 'Importar Visión del Q anterior' },
      { sectionId: 'fs3', section: 'projects', label: 'Importar Proyectos del Q anterior' },
      { sectionId: 'fs5', section: 'team', label: 'Importar Equipo del Q anterior' },
    ];
    map.forEach(({ sectionId, section, label }) => {
      const sec = document.getElementById(sectionId);
      if (!sec) return;
      const head = sec.querySelector('.f-section-head');
      if (!head || head.querySelector('.f-import-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'f-import-btn';
      btn.type = 'button';
      btn.textContent = label;
      btn.style.cssText = 'margin-left:auto;';
      btn.onclick = async (e) => {
        e.preventDefault();
        if (!confirm(`Importar la data de ${section} del Q anterior? Se suma a lo que ya tengas cargado.`)) return;
        await this.ensurePlanExists();
        const ok = await Cascara.importSectionFromPreviousQ(section);
        if (ok) {
          if (section === 'projects') await this.renderProjects();
          else if (section === 'team') await this.renderTeamMembers();
          else if (section === 'vision') await this.populateFs2();
        }
      };
      head.appendChild(btn);
    });
  },

  // ---------- HELPERS ----------
  formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  },
};

window.CascaraForm = CascaraForm;

/* ============================================================
 * CascaraComments — feedback contextual por campo (admins only)
 * ============================================================ */
const CascaraComments = {
  popoverEl: null,

  ensureStyle() {
    if (document.getElementById('cascara-comments-style')) return;
    const s = document.createElement('style');
    s.id = 'cascara-comments-style';
    s.textContent = `
      .f-field-label { position: relative; }
      .cc-icon {
        display: inline-flex; align-items: center; justify-content: center;
        margin-left: 8px; width: 18px; height: 18px; border-radius: 50%;
        background: rgba(16,6,159,0.08); color: #10069F;
        font-size: 11px; font-weight: 600; cursor: pointer;
        vertical-align: middle; line-height: 1; user-select: none;
        transition: background .15s;
      }
      .cc-icon:hover { background: rgba(16,6,159,0.18); }
      .cc-icon.has-comments { background: #10069F; color: #fff; }
      .cc-icon.has-comments:hover { background: #0a00cc; }
      .cc-popover {
        position: absolute; z-index: 99999;
        width: 320px; max-height: 420px; overflow-y: auto;
        background: #fff; border: 1px solid rgba(0,0,0,0.14);
        border-radius: 12px; padding: 14px;
        box-shadow: 0 12px 32px rgba(0,0,0,0.18);
        font: 13px 'Helvetica Neue', sans-serif;
      }
      .cc-popover h4 {
        margin: 0 0 10px; font-size: 11px; font-weight: 700;
        text-transform: uppercase; letter-spacing: 0.06em; color: #52525A;
      }
      .cc-thread { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
      .cc-comment { background: #F5F4F1; padding: 10px 12px; border-radius: 8px; }
      .cc-comment.resolved { opacity: 0.55; }
      .cc-comment-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
      .cc-comment-author { font-weight: 600; font-size: 12px; }
      .cc-comment-time { font-size: 11px; color: #A8A8AC; }
      .cc-comment-text { font-size: 13px; line-height: 1.4; color: #1C1C1F; }
      .cc-comment-actions { margin-top: 6px; font-size: 11px; }
      .cc-comment-actions button { background: none; border: none; color: #10069F; cursor: pointer; padding: 0; font-size: 11px; }
      .cc-empty { color: #A8A8AC; font-size: 12px; padding: 10px 0; text-align: center; }
      .cc-form textarea {
        width: 100%; resize: vertical; min-height: 70px;
        border: 1px solid rgba(0,0,0,0.14); border-radius: 8px;
        padding: 8px 10px; font: 13px 'Helvetica Neue', sans-serif;
        box-sizing: border-box;
      }
      .cc-form-row { display: flex; justify-content: flex-end; margin-top: 6px; gap: 6px; }
      .cc-form-row button {
        background: #10069F; color: #fff; border: none; padding: 6px 14px;
        border-radius: 999px; font-size: 12px; cursor: pointer; font-weight: 500;
      }
      .cc-form-row button.secondary {
        background: transparent; color: #52525A; padding: 6px 12px;
      }
      .cc-backdrop {
        position: fixed; inset: 0; z-index: 99998; background: rgba(10,10,12,0.18);
      }
    `;
    document.head.appendChild(s);
  },

  attachToForm() {
    if (!Cascara.isAdmin()) return;
    this.ensureStyle();

    // Plan-level fields
    const planFields = [
      { sel: '#fs2 textarea[data-field="vision_text"]', label: 'Visión del área' },
      { sel: '#fs2 textarea[data-field="vision_macro_text"]', label: 'Cómo conecta con la visión macro' },
      { sel: '#fs5 textarea[data-field="herramientas"]', label: 'Herramientas y servicios externos' },
      { sel: '#fs5 input[data-field="presupuesto"]', label: 'Presupuesto del Q' },
      { sel: '#fs7 textarea[data-field="notas_ceo"]', label: 'Notas adicionales para el CEO' },
    ];
    planFields.forEach(({ sel, label }) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const lbl = el.parentElement.querySelector('.f-field-label');
      if (lbl && !lbl.querySelector('.cc-icon')) {
        this.injectIcon(lbl, 'plan', Cascara.state.plan.id, el.getAttribute('data-field'));
      }
    });

    // Project-level fields
    document.querySelectorAll('.f-resp-item').forEach(item => {
      const pid = item.dataset.projectId;
      if (!pid) return;
      item.querySelectorAll('[data-target="project"]').forEach(input => {
        const field = input.getAttribute('data-field');
        // El label del nombre del proyecto está en el head, no en un .f-field
        const fieldDiv = input.closest('.f-field');
        const lbl = fieldDiv?.querySelector('.f-field-label');
        if (lbl && !lbl.querySelector('.cc-icon')) {
          this.injectIcon(lbl, 'project', pid, field);
        }
      });
    });

    // Refresh counts
    this.refreshCounts();
  },

  injectIcon(labelEl, targetType, targetId, fieldPath) {
    const icon = document.createElement('span');
    icon.className = 'cc-icon';
    icon.textContent = '💬';
    icon.title = 'Comentarios de admin';
    icon.dataset.targetType = targetType;
    icon.dataset.targetId = targetId;
    icon.dataset.fieldPath = fieldPath;
    icon.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.openPopover(icon, targetType, targetId, fieldPath);
    };
    labelEl.appendChild(icon);
  },

  async refreshCounts() {
    if (!Cascara.state.plan) return;
    const comments = await Cascara.listComments(Cascara.state.plan.id);
    const byKey = new Map();
    comments.forEach(c => {
      if (c.resolved) return;
      const key = `${c.target_type}:${c.target_id}:${c.field_path}`;
      byKey.set(key, (byKey.get(key) || 0) + 1);
    });
    document.querySelectorAll('.cc-icon').forEach(icon => {
      const key = `${icon.dataset.targetType}:${icon.dataset.targetId}:${icon.dataset.fieldPath}`;
      const count = byKey.get(key) || 0;
      icon.classList.toggle('has-comments', count > 0);
      icon.textContent = count > 0 ? count : '💬';
    });
  },

  async openPopover(anchorEl, targetType, targetId, fieldPath) {
    this.closePopover();
    const backdrop = document.createElement('div');
    backdrop.className = 'cc-backdrop';
    backdrop.onclick = () => this.closePopover();
    document.body.appendChild(backdrop);

    const pop = document.createElement('div');
    pop.className = 'cc-popover';
    pop.innerHTML = `
      <h4>Comentarios · ${this.fieldLabel(fieldPath)}</h4>
      <div class="cc-thread">Cargando…</div>
      <div class="cc-form">
        <textarea placeholder="Escribí un comentario…"></textarea>
        <div class="cc-form-row">
          <button class="secondary" data-action="close">Cancelar</button>
          <button data-action="send">Enviar</button>
        </div>
      </div>
    `;
    document.body.appendChild(pop);

    // Position
    const rect = anchorEl.getBoundingClientRect();
    pop.style.top = (window.scrollY + rect.bottom + 8) + 'px';
    pop.style.left = Math.min(window.innerWidth - 340, rect.left) + 'px';

    this.popoverEl = pop;
    this.backdropEl = backdrop;

    // Load thread
    const thread = pop.querySelector('.cc-thread');
    const comments = await Cascara.listCommentsByField(Cascara.state.plan.id, targetType, targetId, fieldPath);
    thread.innerHTML = '';
    if (comments.length === 0) {
      const e = document.createElement('div');
      e.className = 'cc-empty';
      e.textContent = 'Sin comentarios todavía. Sé el primero.';
      thread.appendChild(e);
    } else {
      comments.forEach(c => thread.appendChild(this.renderComment(c)));
    }

    pop.querySelector('[data-action="close"]').onclick = () => this.closePopover();
    pop.querySelector('[data-action="send"]').onclick = async () => {
      const ta = pop.querySelector('textarea');
      const text = ta.value.trim();
      if (!text) return;
      ta.disabled = true;
      const c = await Cascara.addComment(Cascara.state.plan.id, targetType, targetId, fieldPath, text);
      ta.value = '';
      ta.disabled = false;
      if (c) {
        const empty = thread.querySelector('.cc-empty');
        if (empty) empty.remove();
        thread.appendChild(this.renderComment(c));
        this.refreshCounts();
      }
    };
  },

  renderComment(c) {
    const wrap = document.createElement('div');
    wrap.className = 'cc-comment' + (c.resolved ? ' resolved' : '');
    wrap.dataset.commentId = c.id;
    const when = new Date(c.created_at).toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    wrap.innerHTML = `
      <div class="cc-comment-head">
        <span class="cc-comment-author">${c.author_name || 'Anon'}</span>
        <span class="cc-comment-time">${when}</span>
      </div>
      <div class="cc-comment-text">${this.escapeHtml(c.text)}</div>
      <div class="cc-comment-actions">
        ${c.resolved ? '<button data-action="unresolve">Reabrir</button>' : '<button data-action="resolve">Marcar como resuelto</button>'}
      </div>
    `;
    wrap.querySelector('[data-action]').onclick = async (e) => {
      const action = e.currentTarget.dataset.action;
      await Cascara.resolveComment(c.id, action === 'resolve');
      c.resolved = action === 'resolve';
      wrap.classList.toggle('resolved', c.resolved);
      e.currentTarget.parentElement.innerHTML = c.resolved
        ? '<button data-action="unresolve">Reabrir</button>'
        : '<button data-action="resolve">Marcar como resuelto</button>';
      wrap.querySelector('[data-action]').onclick = wrap.querySelector('[data-action]').onclick;
      this.refreshCounts();
    };
    return wrap;
  },

  fieldLabel(path) {
    const map = {
      vision_text: 'Visión del área',
      vision_macro_text: 'Conexión con macro',
      herramientas: 'Herramientas',
      presupuesto: 'Presupuesto',
      notas_ceo: 'Notas al CEO',
      name: 'Nombre del proyecto',
      hypothesis: 'Hipótesis',
      objective: 'Objetivo del Q',
      why_priority: 'Por qué es prioridad',
      business_impact: 'Impacto a nivel negocio',
      what_it_means: 'Qué significa',
      what_implies: 'Qué implica',
      responsible_name: 'Responsable',
      subresponsables: 'Subresponsables',
    };
    return map[path] || path;
  },

  escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  },

  closePopover() {
    if (this.popoverEl) { this.popoverEl.remove(); this.popoverEl = null; }
    if (this.backdropEl) { this.backdropEl.remove(); this.backdropEl = null; }
  },
};

window.CascaraComments = CascaraComments;

/* ============================================================
 * CascaraAdmin — dashboard global para Teo y Facu
 * ============================================================ */
const CascaraAdmin = {
  view: null,

  ensureView() {
    if (this.view) return this.view;
    this.injectStyle();
    const v = document.createElement('div');
    v.id = 'view-admin-dashboard';
    v.className = 'view';
    v.innerHTML = `
      <div class="ad-wrap">
        <button class="ext-back" onclick="goTo('home')">← Volver al home</button>
        <div class="ad-head-row">
          <div class="ad-head">
            <div class="ad-eyebrow">Cáscara · Sistema de Planificación</div>
            <h1 class="ad-title">Dashboard <em>global.</em></h1>
            <div class="ad-sub">Status de los planes del <span id="ad-quarter-name">—</span>. Comentás y aprobás desde acá.</div>
          </div>
          <img src="assets/brand/cascara-jinete-azul.png" class="ad-logo" alt="Cáscara" />
        </div>
        <div class="ad-stats" id="ad-stats"></div>

        <!-- Q control · admin -->
        <div class="ad-qctrl" id="ad-qctrl">
          <div class="ad-qctrl-head">
            <div>
              <div class="ad-qctrl-eyebrow">Control del Q · Admin</div>
              <div class="ad-qctrl-title">Fecha de apertura</div>
              <div class="ad-qctrl-help">Mové esta fecha si el pre-Q se corre. Recalcula automáticamente las 6 quincenas del Ritmo del Q y el Master Timeline.</div>
            </div>
            <div class="ad-qctrl-form">
              <label class="ad-qctrl-label">Apertura del Q
                <input type="date" id="ad-quarter-start" class="ad-qctrl-input" />
              </label>
              <button id="ad-quarter-save" class="ad-qctrl-btn">Actualizar fecha</button>
              <div id="ad-quarter-status" class="ad-qctrl-status"></div>
            </div>
          </div>
          <div class="ad-qctrl-derived" id="ad-quarter-derived"></div>
        </div>

        <div class="ad-section-title">Las 6 áreas</div>
        <div class="ad-grid" id="ad-grid">Cargando…</div>
        <div class="ad-activity-wrap" id="ad-activity-wrap"></div>
      </div>
    `;
    document.body.appendChild(v);
    this.view = v;
    return v;
  },

  injectStyle() {
    if (document.getElementById('cascara-admin-style')) return;
    const s = document.createElement('style');
    s.id = 'cascara-admin-style';
    s.textContent = `
      #view-admin-dashboard { background: var(--cream, #DBD8D3); min-height: 100vh; padding: 40px 60px 80px; font-family: 'Helvetica Neue', Helvetica, Inter, system-ui, sans-serif; }
      #view-admin-dashboard .ad-wrap { max-width: 1200px; margin: 0 auto; }
      #view-admin-dashboard .ad-head-row { display: flex; align-items: flex-end; justify-content: space-between; margin-bottom: 40px; gap: 24px; }
      #view-admin-dashboard .ad-logo { width: 72px; height: 72px; object-fit: contain; flex-shrink: 0; opacity: 0.95; }
      #view-admin-dashboard .ext-back { background: none; border: none; color: var(--ink-muted, #52525A); cursor: pointer; font-size: 13px; padding: 0; margin-bottom: 28px; font-family: inherit; }
      #view-admin-dashboard .ad-eyebrow { font-size: 11px; color: #10069F; text-transform: uppercase; letter-spacing: 0.16em; font-weight: 700; margin-bottom: 12px; }
      #view-admin-dashboard .ad-title { font-size: 56px; font-weight: 800; margin: 0 0 10px; color: var(--ink, #0A0A0C); letter-spacing: -0.025em; line-height: 0.95; }
      #view-admin-dashboard .ad-title em { font-family: 'Redaction', 'Times New Roman', Georgia, serif; font-style: italic; color: #10069F; font-weight: 400; }
      #view-admin-dashboard .ad-sub { font-size: 14px; color: var(--ink-muted, #52525A); }
      #view-admin-dashboard .ad-section-title { font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-muted); margin: 30px 0 14px; }
      #view-admin-dashboard .ad-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 20px; }

      /* Q control · admin */
      #view-admin-dashboard .ad-qctrl {
        margin-top: 22px;
        background: rgba(255,255,255,0.65);
        border: 1px solid rgba(0,0,0,0.06);
        border-radius: 16px;
        padding: 20px 24px;
      }
      #view-admin-dashboard .ad-qctrl-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 28px; flex-wrap: wrap; }
      #view-admin-dashboard .ad-qctrl-eyebrow { font-size: 10.5px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #10069F; margin-bottom: 4px; }
      #view-admin-dashboard .ad-qctrl-title { font-size: 22px; font-weight: 800; letter-spacing: -0.018em; color: var(--ink); margin-bottom: 6px; }
      #view-admin-dashboard .ad-qctrl-help { font-size: 12.5px; color: var(--ink-muted); max-width: 520px; line-height: 1.45; }
      #view-admin-dashboard .ad-qctrl-form { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
      #view-admin-dashboard .ad-qctrl-label { display: flex; flex-direction: column; gap: 6px; font-size: 10.5px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-muted); }
      #view-admin-dashboard .ad-qctrl-input {
        padding: 9px 12px; border: 1px solid rgba(0,0,0,0.12); border-radius: 8px;
        font-family: inherit; font-size: 14px; background: #fff; color: var(--ink); min-width: 170px;
      }
      #view-admin-dashboard .ad-qctrl-input:focus { outline: none; border-color: #10069F; }
      #view-admin-dashboard .ad-qctrl-btn {
        padding: 10px 18px; border: 0; background: #10069F; color: #fff;
        border-radius: 8px; font-family: inherit; font-size: 13px; font-weight: 700;
        letter-spacing: 0.04em; cursor: pointer; transition: background 0.15s;
      }
      #view-admin-dashboard .ad-qctrl-btn:hover { background: #0a047a; }
      #view-admin-dashboard .ad-qctrl-btn:disabled { background: #B5B3AF; cursor: not-allowed; }
      #view-admin-dashboard .ad-qctrl-status { font-size: 12px; color: var(--ink-muted); font-style: italic; min-height: 18px; }
      #view-admin-dashboard .ad-qctrl-status.ok { color: #00733C; font-style: normal; }
      #view-admin-dashboard .ad-qctrl-status.err { color: #C53030; font-style: normal; }
      #view-admin-dashboard .ad-qctrl-derived {
        margin-top: 18px; padding-top: 16px;
        border-top: 1px dashed rgba(0,0,0,0.1);
        display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px;
      }
      #view-admin-dashboard .ad-qctrl-quincena { font-size: 12px; color: var(--ink-muted); }
      #view-admin-dashboard .ad-qctrl-quincena strong { display: block; font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink); margin-bottom: 2px; }

      /* Stats top bar */
      #view-admin-dashboard .ad-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
      .ad-stat {
        background: rgba(255,255,255,0.55); border: 1px solid rgba(0,0,0,0.06);
        border-radius: 14px; padding: 18px 20px;
        display: flex; flex-direction: column; gap: 4px;
      }
      .ad-stat-num { font-size: 32px; font-weight: 800; letter-spacing: -0.02em; color: var(--ink); line-height: 1; }
      .ad-stat-num em { font-family: var(--font-serif); font-style: italic; font-weight: 400; color: var(--ink-muted); font-size: 18px; margin-left: 2px; }
      .ad-stat-lbl { font-size: 10.5px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-muted); margin-top: 6px; }
      .ad-stat.highlight .ad-stat-num { color: var(--blue); }
      .ad-stat.warning .ad-stat-num { color: #C39A00; }

      /* Activity feed */
      #view-admin-dashboard .ad-activity-wrap { margin-top: 30px; }
      .ad-activity-card {
        background: rgba(255,255,255,0.5); border: 1px solid rgba(0,0,0,0.06);
        border-radius: 14px; padding: 8px 4px;
      }
      .ad-activity-item {
        padding: 12px 18px; border-bottom: 1px solid rgba(0,0,0,0.05);
        display: flex; align-items: baseline; gap: 12px; font-size: 13px;
      }
      .ad-activity-item:last-child { border-bottom: none; }
      .ad-activity-when { font-size: 11px; color: var(--ink-muted); font-family: var(--font-serif); font-style: italic; flex-shrink: 0; min-width: 90px; }
      .ad-activity-who { font-weight: 700; }
      .ad-activity-what { color: var(--ink-soft); }
      .ad-activity-area { background: rgba(16,6,159,0.08); color: var(--blue); padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; margin-left: auto; flex-shrink: 0; }
      .ad-plan-card {
        background: rgba(255,255,255,0.6); border: 1px solid rgba(0,0,0,0.07);
        border-radius: 18px; padding: 24px; cursor: pointer;
        transition: transform .15s, box-shadow .15s, background .15s;
      }
      .ad-plan-card:hover { background: #fff; transform: translateY(-2px); box-shadow: 0 10px 30px rgba(0,0,0,0.06); }
      .ad-plan-num { width: 32px; height: 32px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; color: #fff; font-weight: 700; font-size: 13px; margin-bottom: 14px; }
      .ad-plan-area { font-size: 20px; font-weight: 700; margin-bottom: 4px; }
      .ad-plan-director { font-size: 13px; color: var(--ink-muted, #52525A); margin-bottom: 16px; }
      .ad-plan-meta { display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; }
      .ad-plan-meta-row { display: flex; justify-content: space-between; }
      .ad-plan-meta-label { color: var(--ink-muted, #52525A); }
      .ad-plan-meta-val { font-weight: 600; }
      .ad-status-pill { padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; }
      .ad-status-not_started { background: rgba(82,82,90,0.1); color: #52525A; }
      .ad-status-draft { background: rgba(16,6,159,0.1); color: #10069F; }
      .ad-status-in_review { background: rgba(255,92,0,0.12); color: #FF5C00; }
      .ad-status-approved { background: rgba(0,179,107,0.12); color: #00B36B; }
      .ad-status-in_progress { background: rgba(16,6,159,0.1); color: #10069F; }
      .ad-status-closed { background: rgba(82,82,90,0.12); color: #52525A; }
      .ad-comments-badge { background: #10069F; color: #fff; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
    `;
    document.head.appendChild(s);
  },

  async enter() {
    if (!Cascara.isAdmin()) {
      alert('Vista disponible solo para Admin (Teo y Facu).');
      goTo('home');
      return;
    }
    this.ensureView();
    const qName = document.getElementById('ad-quarter-name');
    if (qName && Cascara.state.quarter) qName.textContent = Cascara.state.quarter.name;

    // === Q control (admin) ===
    this.renderQuarterControl();

    const grid = document.getElementById('ad-grid');
    grid.innerHTML = 'Cargando…';

    const { data: areas } = await Cascara.client.from('areas').select('*').order('order_index');
    const plans = await Cascara.listAllPlansForQuarter();
    const plansByArea = new Map(plans.map(p => [p.area_id, p]));

    // === Stats agregados ===
    const totalAreas = (areas || []).length;
    const plansStarted = plans.length;
    const plansApproved = plans.filter(p => ['approved', 'in_progress', 'closed'].includes(p.status)).length;
    const totalProjects = plans.reduce((sum, p) => sum + (p.projects_count || 0), 0);
    const openComments = plans.reduce((sum, p) => sum + (p.comments_open || 0), 0);

    const statsEl = document.getElementById('ad-stats');
    if (statsEl) {
      statsEl.innerHTML = `
        <div class="ad-stat">
          <div class="ad-stat-num">${plansStarted}<em>/${totalAreas}</em></div>
          <div class="ad-stat-lbl">Áreas con plan iniciado</div>
        </div>
        <div class="ad-stat highlight">
          <div class="ad-stat-num">${plansApproved}<em>/${totalAreas}</em></div>
          <div class="ad-stat-lbl">Planes aprobados</div>
        </div>
        <div class="ad-stat">
          <div class="ad-stat-num">${totalProjects}</div>
          <div class="ad-stat-lbl">Proyectos cargados</div>
        </div>
        <div class="ad-stat ${openComments > 0 ? 'warning' : ''}">
          <div class="ad-stat-num">${openComments}</div>
          <div class="ad-stat-lbl">Comentarios sin resolver</div>
        </div>
      `;
    }

    // === Actividad reciente ===
    this.renderActivity();

    grid.innerHTML = '';
    (areas || []).forEach((a, i) => {
      const p = plansByArea.get(a.id);
      const card = document.createElement('div');
      card.className = 'ad-plan-card';
      const statusTxt = p ? p.status : 'not_started';
      const statusLabel = p ? this.statusLabel(p.status) : 'Sin iniciar';
      const projects = p?.projects_count ?? 0;
      const openComments = p?.comments_open ?? 0;
      const lastUpdate = p?.updated_at ? new Date(p.updated_at).toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
      const directorName = p?.director?.name || '—';
      card.innerHTML = `
        <div class="ad-plan-num" style="background:${a.color || '#10069F'}">${String(i+1).padStart(2,'0')}</div>
        <div class="ad-plan-area">${a.name}</div>
        <div class="ad-plan-director">${directorName}</div>
        <div class="ad-plan-meta">
          <div class="ad-plan-meta-row"><span class="ad-plan-meta-label">Estado</span><span class="ad-status-pill ad-status-${statusTxt}">${statusLabel}</span></div>
          <div class="ad-plan-meta-row"><span class="ad-plan-meta-label">Proyectos cargados</span><span class="ad-plan-meta-val">${projects}</span></div>
          <div class="ad-plan-meta-row"><span class="ad-plan-meta-label">Comentarios sin resolver</span><span class="${openComments > 0 ? 'ad-comments-badge' : 'ad-plan-meta-val'}">${openComments}</span></div>
          <div class="ad-plan-meta-row"><span class="ad-plan-meta-label">Última actividad</span><span class="ad-plan-meta-val">${lastUpdate}</span></div>
        </div>
        ${p ? `
          <select class="ad-status-select" data-plan-id="${p.id}" onclick="event.stopPropagation()">
            <option value="draft" ${p.status === 'draft' ? 'selected' : ''}>Borrador</option>
            <option value="in_review" ${p.status === 'in_review' ? 'selected' : ''}>En revisión</option>
            <option value="approved" ${p.status === 'approved' ? 'selected' : ''}>Aprobado · genera oficial</option>
            <option value="in_progress" ${p.status === 'in_progress' ? 'selected' : ''}>En ejecución</option>
            <option value="closed" ${p.status === 'closed' ? 'selected' : ''}>Cerrado</option>
          </select>
          ${['approved', 'in_progress', 'closed'].includes(p.status) ? '<div class="ad-approve-info">✓ Presentación oficial publicada</div>' : ''}
        ` : '<div style="margin-top:12px; font-size:11.5px; color:#A8A8AC;">El plan se crea cuando el Director entra al form.</div>'}
      `;
      card.onclick = async () => {
        Cascara.state.area = a;
        // No crear el plan al abrir desde admin: si el Director no entró aún, el form muestra vacío
        Cascara.state.plan = p || null;
        goTo('formulario');
      };
      // Status select handler
      const select = card.querySelector('.ad-status-select');
      if (select) {
        select.onchange = async (e) => {
          e.stopPropagation();
          const planId = select.dataset.planId;
          const newStatus = select.value;
          await Cascara.client.from('plans').update({ status: newStatus }).eq('id', planId);
          await CascaraPresentations.refreshMarks();
          // Refrescar dashboard
          this.enter();
        };
      }
      grid.appendChild(card);
    });

    // Refrescar las marcas Ejemplo/Oficial en home
    CascaraPresentations.refreshMarks();
  },

  renderQuarterControl() {
    const q = Cascara.state.quarter;
    if (!q) return;
    const input = document.getElementById('ad-quarter-start');
    const btn = document.getElementById('ad-quarter-save');
    const status = document.getElementById('ad-quarter-status');
    const derived = document.getElementById('ad-quarter-derived');
    if (!input || !btn) return;

    // Set current value
    input.value = q.start_date || '';

    // Pintar las 6 quincenas derivadas
    const renderDerived = (startDateISO) => {
      if (!derived) return;
      const fakeQ = { start_date: startDateISO || q.start_date };
      const fnights = CascaraForm.deriveFortnightsFromQuarter(fakeQ);
      derived.innerHTML = fnights.map(f => `
        <div class="ad-qctrl-quincena">
          <strong>${f.label}</strong>
          ${f.dateLabel}
        </div>
      `).join('');
    };
    renderDerived(input.value);

    input.oninput = () => {
      renderDerived(input.value);
      if (status) { status.textContent = 'Sin guardar — presioná Actualizar fecha'; status.className = 'ad-qctrl-status'; }
    };

    btn.onclick = async () => {
      const newDate = input.value;
      if (!newDate) { if (status) { status.textContent = 'Elegí una fecha válida.'; status.className = 'ad-qctrl-status err'; } return; }
      const confirmed = confirm(`Vas a mover la apertura del ${q.name} al ${newDate}.\n\nEsto recalcula las 6 quincenas del Ritmo del Q y la grilla del Master Timeline. Las fechas que ya cargaron los directores (KPIs, hitos) no se mueven solas — quedan ancladas a su fecha original.\n\n¿Confirmás?`);
      if (!confirmed) return;
      btn.disabled = true;
      if (status) { status.textContent = 'Actualizando…'; status.className = 'ad-qctrl-status'; }
      const r = await Cascara.updateQuarterStartDate(newDate);
      btn.disabled = false;
      if (r.ok) {
        if (status) { status.textContent = `Actualizado: nueva apertura ${r.patch.start_date} · cierre estimado ${r.patch.end_date}`; status.className = 'ad-qctrl-status ok'; }
        renderDerived(r.patch.start_date);
      } else {
        if (status) { status.textContent = `Error: ${r.error}`; status.className = 'ad-qctrl-status err'; }
      }
    };
  },

  statusLabel(s) {
    return ({
      draft: 'Borrador',
      in_review: 'En revisión',
      approved: 'Aprobado',
      in_progress: 'En ejecución',
      closed: 'Cerrado',
    })[s] || s;
  },

  async renderActivity() {
    const wrap = document.getElementById('ad-activity-wrap');
    if (!wrap) return;
    if (!Cascara.state.quarter) return;

    // Combinar últimos: planes actualizados, comentarios, check-ins
    const [{ data: plansRecent }, { data: commentsRecent }, { data: checkinsRecent }] = await Promise.all([
      Cascara.client.from('plans').select('*, area:areas(name)').eq('quarter_id', Cascara.state.quarter.id).order('updated_at', { ascending: false }).limit(8),
      Cascara.client.from('comments').select('*, plan:plans(area:areas(name))').order('created_at', { ascending: false }).limit(6),
      Cascara.client.from('check_in_sessions').select('*, plan:plans(area:areas(name))').order('created_at', { ascending: false }).limit(4),
    ]);

    const events = [];
    (plansRecent || []).forEach(p => {
      events.push({
        when: p.updated_at,
        who: 'Plan',
        what: `actualizado · status: ${this.statusLabel(p.status)}`,
        area: p.area?.name,
      });
    });
    (commentsRecent || []).forEach(c => {
      events.push({
        when: c.created_at,
        who: c.author_name || 'Anon',
        what: `comentó "${(c.text || '').slice(0, 80)}${(c.text || '').length > 80 ? '…' : ''}"`,
        area: c.plan?.area?.name,
      });
    });
    (checkinsRecent || []).forEach(s => {
      events.push({
        when: s.created_at,
        who: s.author_name || 'Anon',
        what: 'hizo un check-in del Q',
        area: s.plan?.area?.name,
      });
    });

    events.sort((a, b) => new Date(b.when) - new Date(a.when));
    const top = events.slice(0, 10);

    if (top.length === 0) {
      wrap.innerHTML = `
        <div class="ad-section-title">Actividad reciente</div>
        <div class="ad-activity-card">
          <div class="ad-activity-item">
            <span class="ad-activity-when">—</span>
            <span class="ad-activity-what">Sin actividad todavía. Cuando un Director cargue su plan o haga un check-in vas a verlo acá.</span>
          </div>
        </div>
      `;
      return;
    }

    wrap.innerHTML = `
      <div class="ad-section-title">Actividad reciente</div>
      <div class="ad-activity-card">
        ${top.map(e => `
          <div class="ad-activity-item">
            <span class="ad-activity-when">${this.timeAgo(e.when)}</span>
            <span><span class="ad-activity-who">${this.escape(e.who)}</span> <span class="ad-activity-what">${this.escape(e.what)}</span></span>
            ${e.area ? `<span class="ad-activity-area">${this.escape(e.area)}</span>` : ''}
          </div>
        `).join('')}
      </div>
    `;
  },

  timeAgo(iso) {
    if (!iso) return '—';
    const seconds = Math.floor((Date.now() - new Date(iso)) / 1000);
    if (seconds < 60) return 'hace segundos';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `hace ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `hace ${hours} h`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `hace ${days} d`;
    return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: 'short' });
  },

  escape(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  },
};

window.CascaraAdmin = CascaraAdmin;

/* ============================================================
 * CascaraCheckIns — UNA sesión cubre TODOS los proyectos del área
 * Solo accesible para directores y admins
 * ============================================================ */
const CascaraCheckIns = {
  view: null,

  ensureView() {
    if (this.view) return this.view;
    this.injectStyle();
    const v = document.createElement('div');
    v.id = 'view-check-ins';
    v.className = 'view';
    v.innerHTML = `
      <div class="ci-wrap">
        <button class="ext-back" onclick="goTo('home')">← Volver al home</button>
        <div class="ci-head-row">
          <div class="ci-head">
            <div class="ci-eyebrow">Cáscara · Check-ins quincenales</div>
            <h1 class="ci-title">El ritmo<em>de <span id="ci-area-name">tu área</span>.</em></h1>
            <div class="ci-sub">Cada 2 semanas el equipo del área se junta a revisar cada Proyecto. Un check-in cubre todos los proyectos del Q.</div>
          </div>
          <img src="assets/brand/cascara-jinete-azul.png" class="ci-logo" alt="Cáscara" />
        </div>
        <div id="ci-content">Cargando…</div>
      </div>
    `;
    document.body.appendChild(v);
    this.view = v;
    return v;
  },

  injectStyle() {
    if (document.getElementById('cascara-checkins-style')) return;
    const s = document.createElement('style');
    s.id = 'cascara-checkins-style';
    s.textContent = `
      #view-check-ins { background: var(--cream, #DBD8D3); min-height: 100vh; padding: 36px 50px 60px; font-family: 'Helvetica Neue', Helvetica, Inter, system-ui, sans-serif; }
      #view-check-ins .ci-wrap { max-width: 920px; margin: 0 auto; }
      #view-check-ins .ci-head-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin-bottom: 32px; }
      #view-check-ins .ci-logo { width: 64px; height: 64px; object-fit: contain; flex-shrink: 0; opacity: 0.95; }
      #view-check-ins .ext-back { background: none; border: none; color: #52525A; cursor: pointer; font-size: 13px; padding: 0; margin-bottom: 24px; font-family: inherit; }
      #view-check-ins .ci-eyebrow { font-size: 11px; color: #10069F; text-transform: uppercase; letter-spacing: 0.16em; font-weight: 700; margin-bottom: 12px; }
      #view-check-ins .ci-title { font-size: 52px; font-weight: 800; margin: 0 0 8px; color: #0A0A0C; line-height: 0.95; letter-spacing: -0.025em; }
      #view-check-ins .ci-title em { font-family: 'Redaction', 'Times New Roman', Georgia, serif; font-style: italic; color: #10069F; font-weight: 400; }
      #view-check-ins .ci-sub { font-size: 14px; color: #52525A; max-width: 680px; line-height: 1.5; }

      /* Botón principal para arrancar un check-in */
      .ci-start-card {
        background: rgba(255,255,255,0.6); border: 1px solid rgba(0,0,0,0.07);
        border-radius: 18px; padding: 28px; margin-bottom: 24px;
        display: flex; align-items: center; justify-content: space-between; gap: 20px;
      }
      .ci-start-info { flex: 1; }
      .ci-start-eyebrow { font-size: 11px; color: #10069F; text-transform: uppercase; letter-spacing: 0.12em; font-weight: 700; margin-bottom: 6px; }
      .ci-start-title { font-size: 22px; font-weight: 700; margin-bottom: 4px; color: #0A0A0C; }
      .ci-start-meta { font-size: 13px; color: #52525A; }
      .ci-start-btn {
        background: #10069F; color: #fff; border: none; padding: 14px 24px;
        border-radius: 999px; font-size: 14px; font-weight: 600; cursor: pointer;
        white-space: nowrap;
      }
      .ci-start-btn:hover { background: #0a00cc; }

      /* Última sesión */
      .ci-last-summary {
        background: rgba(255,255,255,0.5); border: 1px solid rgba(0,0,0,0.07);
        border-radius: 14px; padding: 20px 22px; margin-bottom: 20px;
      }
      .ci-last-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px; }
      .ci-last-when { font-size: 12px; color: #52525A; }
      .ci-last-title { font-size: 15px; font-weight: 700; }
      .ci-counts { display: flex; gap: 10px; }
      .ci-count {
        padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 600;
        display: inline-flex; align-items: center; gap: 6px;
      }
      .ci-count-dot { width: 8px; height: 8px; border-radius: 50%; }
      .ci-count.g { background: rgba(0,179,107,0.12); color: #00733C; }
      .ci-count.g .ci-count-dot { background: #00B36B; }
      .ci-count.a { background: rgba(195,154,0,0.12); color: #7A6000; }
      .ci-count.a .ci-count-dot { background: #C39A00; }
      .ci-count.r { background: rgba(229,57,53,0.12); color: #A02220; }
      .ci-count.r .ci-count-dot { background: #E53935; }

      /* Form de check-in */
      .ci-form-wrap {
        background: rgba(255,255,255,0.6); border: 1px solid rgba(0,0,0,0.07);
        border-radius: 18px; padding: 28px; margin-bottom: 20px;
      }
      .ci-form-head { font-size: 18px; font-weight: 700; margin-bottom: 18px; }
      .ci-summary-field { margin-bottom: 22px; }
      .ci-summary-field label {
        font-size: 11.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
        color: #52525A; margin-bottom: 6px; display: block;
      }
      .ci-summary-field textarea {
        width: 100%; box-sizing: border-box; border: 1px solid rgba(0,0,0,0.14);
        border-radius: 8px; padding: 10px 12px; min-height: 60px;
        font: 13px 'Helvetica Neue', sans-serif; resize: vertical;
      }

      .ci-proj-row {
        padding: 18px 0; border-top: 1px solid rgba(0,0,0,0.07);
      }
      .ci-proj-row:first-of-type { border-top: none; padding-top: 8px; }
      .ci-proj-row-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px; gap: 12px; }
      .ci-proj-name { font-size: 15px; font-weight: 700; }
      .ci-proj-resp { font-size: 12px; color: #52525A; }
      .ci-proj-num {
        display: inline-block; background: rgba(16,6,159,0.08); color: #10069F;
        padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 700;
        margin-right: 8px;
      }
      .ci-status-row { display: flex; gap: 8px; margin-bottom: 10px; }
      .ci-status-btn {
        flex: 1; padding: 9px 12px; border-radius: 8px; border: 2px solid transparent;
        background: rgba(0,0,0,0.04); cursor: pointer; font-size: 12.5px; font-weight: 500;
        transition: all .15s; font-family: inherit;
      }
      .ci-status-btn[data-status="green"]:hover, .ci-status-btn.selected[data-status="green"] { background: rgba(0,179,107,0.14); border-color: #00B36B; color: #00733C; }
      .ci-status-btn[data-status="amber"]:hover, .ci-status-btn.selected[data-status="amber"] { background: rgba(195,154,0,0.14); border-color: #C39A00; color: #7A6000; }
      .ci-status-btn[data-status="red"]:hover, .ci-status-btn.selected[data-status="red"] { background: rgba(229,57,53,0.12); border-color: #E53935; color: #A02220; }
      .ci-row-inputs { display: grid; grid-template-columns: 2fr 1fr; gap: 10px; }
      .ci-row-inputs input, .ci-row-inputs textarea {
        width: 100%; box-sizing: border-box; border: 1px solid rgba(0,0,0,0.14);
        border-radius: 8px; padding: 8px 10px; font: 13px 'Helvetica Neue', sans-serif;
      }
      .ci-row-inputs textarea { min-height: 38px; resize: vertical; }

      .ci-form-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 24px; padding-top: 20px; border-top: 1px solid rgba(0,0,0,0.07); }
      .ci-cancel { background: transparent; border: 1px solid rgba(0,0,0,0.14); padding: 10px 20px; border-radius: 999px; font-size: 13px; cursor: pointer; }
      .ci-submit {
        background: #10069F; color: #fff; border: none; padding: 10px 24px;
        border-radius: 999px; font-size: 13px; font-weight: 600; cursor: pointer;
      }
      .ci-submit:disabled { opacity: 0.6; cursor: wait; }

      /* Historial */
      .ci-history-wrap { margin-top: 24px; }
      .ci-history-title { font-size: 11.5px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #52525A; margin-bottom: 12px; }
      .ci-hist-card {
        background: rgba(255,255,255,0.4); border: 1px solid rgba(0,0,0,0.06);
        border-radius: 12px; padding: 16px 20px; margin-bottom: 10px;
      }
      .ci-hist-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; cursor: pointer; }
      .ci-hist-when { font-size: 13px; font-weight: 600; }
      .ci-hist-by { font-size: 12px; color: #52525A; }
      .ci-hist-entries { display: none; margin-top: 10px; }
      .ci-hist-entries.open { display: block; }
      .ci-hist-entry { padding: 8px 0; border-top: 1px solid rgba(0,0,0,0.05); font-size: 12.5px; }
      .ci-hist-entry-name { font-weight: 600; }
      .ci-hist-entry-status { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; margin-left: 6px; }
      .ci-hist-entry-status.green { background: rgba(0,179,107,0.14); color: #00733C; }
      .ci-hist-entry-status.amber { background: rgba(195,154,0,0.14); color: #7A6000; }
      .ci-hist-entry-status.red { background: rgba(229,57,53,0.12); color: #A02220; }

      /* Estado vacío + ejemplo */
      .ci-empty-state {
        background: rgba(255,255,255,0.45); border: 1px dashed rgba(16,6,159,0.25);
        border-radius: 16px; padding: 24px; margin-bottom: 20px;
      }
      .ci-empty-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
      .ci-empty-icon {
        background: rgba(16,6,159,0.1); color: #10069F;
        width: 28px; height: 28px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font-size: 14px; font-weight: 700;
      }
      .ci-empty-title { font-size: 15px; font-weight: 700; }
      .ci-empty-msg { font-size: 13px; color: #52525A; line-height: 1.5; margin-bottom: 16px; }
      .ci-example-label {
        font-size: 11px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase;
        color: rgba(195,154,0,0.95); padding: 4px 10px;
        background: rgba(195,154,0,0.12); border: 1px solid rgba(195,154,0,0.3);
        border-radius: 999px; display: inline-flex; align-items: center; gap: 6px;
        margin-bottom: 16px;
      }
      .ci-example { pointer-events: none; opacity: 0.85; }
    `;
    document.head.appendChild(s);
  },

  async enter() {
    if (!Cascara.state.user) {
      alert('Tenés que estar logueado para entrar a check-ins.');
      goTo('login');
      return;
    }
    const role = Cascara.state.user.role;
    if (role !== 'director' && role !== 'admin') {
      alert('Los check-ins son solo para directores y admins.');
      goTo('home');
      return;
    }
    this.ensureView();
    const area = Cascara.state.area;
    const nameEl = document.getElementById('ci-area-name');
    if (nameEl && area) nameEl.textContent = area.name;

    const container = document.getElementById('ci-content');
    container.innerHTML = 'Cargando…';

    const projects = await Cascara.listProjectsOfMyArea();
    const sessions = await Cascara.listSessionsForMyPlan();

    container.innerHTML = '';

    if (projects.length === 0) {
      container.appendChild(this.buildEmptyStateWithExample());
      return;
    }

    // Start card con resumen de última sesión
    container.appendChild(this.buildStartCard(projects, sessions));

    // Historial
    if (sessions.length > 0) {
      container.appendChild(this.buildHistorySection(sessions));
    }
  },

  buildStartCard(projects, sessions) {
    const last = sessions[0];
    const card = document.createElement('div');
    card.className = 'ci-start-card';
    let metaHtml = `${projects.length} proyectos en este Q. Sin check-ins todavía.`;
    if (last) {
      const when = new Date(last.created_at).toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      metaHtml = `${projects.length} proyectos · último check-in ${when} por ${last.author_name || '—'}`;
    }
    card.innerHTML = `
      <div class="ci-start-info">
        <div class="ci-start-eyebrow">Próximo check-in</div>
        <div class="ci-start-title">${last ? 'Hacer un nuevo check-in del Q' : 'Hacer el primer check-in del Q'}</div>
        <div class="ci-start-meta">${metaHtml}</div>
      </div>
      <button class="ci-start-btn">+ Hacer check-in</button>
    `;
    card.querySelector('.ci-start-btn').onclick = () => this.openCheckInForm(projects);
    return card;
  },

  openCheckInForm(projects) {
    const container = document.getElementById('ci-content');
    container.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'ci-form-wrap';
    wrap.innerHTML = `
      <div class="ci-form-head">Check-in del Q — revisá todos los proyectos del área</div>
      <div class="ci-summary-field">
        <label>Resumen general (opcional)</label>
        <textarea placeholder="Una línea sobre cómo viene el área en general este período…" id="ci-summary-input"></textarea>
      </div>
      <div id="ci-projects-list"></div>
      <div class="ci-form-actions">
        <button class="ci-cancel" type="button">Cancelar</button>
        <button class="ci-submit" type="button" disabled>Registrar check-in</button>
      </div>
    `;
    container.appendChild(wrap);

    const list = wrap.querySelector('#ci-projects-list');
    const state = new Map(); // project_id -> { status, note, blocker }

    projects.forEach((p, i) => {
      const num = String(i + 1).padStart(2, '0');
      const row = document.createElement('div');
      row.className = 'ci-proj-row';
      row.dataset.projectId = p.id;
      row.innerHTML = `
        <div class="ci-proj-row-head">
          <div><span class="ci-proj-num">${num}</span><span class="ci-proj-name">${this.escapeHtml(p.name || 'Proyecto sin nombre')}</span></div>
          <div class="ci-proj-resp">${p.responsible_name ? 'Resp: ' + this.escapeHtml(p.responsible_name) : ''}</div>
        </div>
        <div class="ci-status-row">
          <button class="ci-status-btn" data-status="green" type="button">🟢 Verde · en track</button>
          <button class="ci-status-btn" data-status="amber" type="button">🟡 Ámbar · con riesgo</button>
          <button class="ci-status-btn" data-status="red" type="button">🔴 Rojo · trabado</button>
        </div>
        <div class="ci-row-inputs">
          <textarea placeholder="¿Cómo viene? (1 línea)" data-field="note"></textarea>
          <input type="text" placeholder="Bloqueante (si lo hay)" data-field="blocker" />
        </div>
      `;
      row.querySelectorAll('.ci-status-btn').forEach(btn => {
        btn.onclick = () => {
          row.querySelectorAll('.ci-status-btn').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
          const cur = state.get(p.id) || {};
          state.set(p.id, { ...cur, status: btn.dataset.status });
          this.refreshSubmitState(wrap, projects, state);
        };
      });
      row.querySelector('[data-field="note"]').oninput = (e) => {
        const cur = state.get(p.id) || {};
        state.set(p.id, { ...cur, note: e.target.value });
      };
      row.querySelector('[data-field="blocker"]').oninput = (e) => {
        const cur = state.get(p.id) || {};
        state.set(p.id, { ...cur, blocker: e.target.value });
      };
      list.appendChild(row);
    });

    wrap.querySelector('.ci-cancel').onclick = () => this.enter();
    wrap.querySelector('.ci-submit').onclick = async () => {
      const submitBtn = wrap.querySelector('.ci-submit');
      submitBtn.disabled = true; submitBtn.textContent = 'Guardando…';
      const summary = wrap.querySelector('#ci-summary-input').value.trim();
      const entries = projects.map(p => {
        const s = state.get(p.id);
        return { project_id: p.id, status: s.status, note: s.note || '', blocker: s.blocker || '' };
      });
      await Cascara.createCheckInSession({ summary, entries });
      this.enter();
    };
  },

  refreshSubmitState(wrap, projects, state) {
    // Enable submit solo si todos los proyectos tienen status
    const allReady = projects.every(p => state.get(p.id)?.status);
    const btn = wrap.querySelector('.ci-submit');
    btn.disabled = !allReady;
    btn.textContent = allReady ? 'Registrar check-in' : `Completá los ${projects.length} proyectos`;
  },

  buildHistorySection(sessions) {
    const wrap = document.createElement('div');
    wrap.className = 'ci-history-wrap';
    wrap.innerHTML = '<div class="ci-history-title">Historial de check-ins</div>';

    sessions.forEach(sess => {
      const counts = { green: 0, amber: 0, red: 0 };
      (sess.entries || []).forEach(e => { if (counts[e.status] !== undefined) counts[e.status]++; });
      const when = new Date(sess.created_at).toLocaleString('es-AR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      const card = document.createElement('div');
      card.className = 'ci-hist-card';
      card.innerHTML = `
        <div class="ci-hist-head">
          <div>
            <div class="ci-hist-when">${when}</div>
            <div class="ci-hist-by">por ${sess.author_name || '—'}</div>
          </div>
          <div class="ci-counts">
            <span class="ci-count g"><span class="ci-count-dot"></span>${counts.green}</span>
            <span class="ci-count a"><span class="ci-count-dot"></span>${counts.amber}</span>
            <span class="ci-count r"><span class="ci-count-dot"></span>${counts.red}</span>
          </div>
        </div>
        ${sess.summary ? `<div style="font-size:13px;color:#52525A;line-height:1.5;margin-bottom:8px;font-style:italic;">"${this.escapeHtml(sess.summary)}"</div>` : ''}
        <div class="ci-hist-entries">
          ${(sess.entries || []).map(e => `
            <div class="ci-hist-entry">
              <span class="ci-hist-entry-name">${this.escapeHtml(e.project?.name || 'Proyecto')}</span>
              <span class="ci-hist-entry-status ${e.status}">${e.status}</span>
              ${e.note ? `<div style="margin-top:4px;color:#52525A;">${this.escapeHtml(e.note)}</div>` : ''}
              ${e.blocker ? `<div style="margin-top:4px;color:#A02220;"><strong>Bloqueante:</strong> ${this.escapeHtml(e.blocker)}</div>` : ''}
            </div>
          `).join('')}
        </div>
      `;
      card.querySelector('.ci-hist-head').onclick = () => {
        card.querySelector('.ci-hist-entries').classList.toggle('open');
      };
      wrap.appendChild(card);
    });

    return wrap;
  },

  buildEmptyStateWithExample() {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="ci-empty-state">
        <div class="ci-empty-head">
          <div class="ci-empty-icon">!</div>
          <div class="ci-empty-title">Tu plan del Q todavía no tiene Proyectos cargados</div>
        </div>
        <div class="ci-empty-msg">
          Para hacer check-ins primero tenés que cargar los Proyectos de tu área desde el formulario. Cuando los tengas cargados, vas a poder revisarlos todos juntos acá cada dos semanas.
        </div>
        <button class="ci-start-btn" onclick="goTo('formulario')">Ir a cargar mi planificación →</button>
      </div>

      <div class="ci-example-label">▸ Ejemplo · así se verá un check-in cuando tengas proyectos</div>
      <div class="ci-example">
        <div class="ci-form-wrap">
          <div class="ci-form-head">Check-in del Q — revisá todos los proyectos del área</div>
          <div class="ci-summary-field">
            <label>Resumen general (opcional)</label>
            <textarea readonly>Buen ritmo en general. Contenido encaminado, pero comercial necesita ajuste en el funnel B2C.</textarea>
          </div>

          <div class="ci-proj-row" style="border-top:none;padding-top:8px;">
            <div class="ci-proj-row-head">
              <div><span class="ci-proj-num">01</span><span class="ci-proj-name">Liderazgo del equipo de contenido</span></div>
              <div class="ci-proj-resp">Resp: Azu</div>
            </div>
            <div class="ci-status-row">
              <button class="ci-status-btn selected" data-status="green" type="button">🟢 Verde · en track</button>
              <button class="ci-status-btn" data-status="amber" type="button">🟡 Ámbar · con riesgo</button>
              <button class="ci-status-btn" data-status="red" type="button">🔴 Rojo · trabado</button>
            </div>
            <div class="ci-row-inputs">
              <textarea readonly>Roles documentados al 80%. 1:1 mensuales arrancaron.</textarea>
              <input type="text" readonly value="" />
            </div>
          </div>

          <div class="ci-proj-row">
            <div class="ci-proj-row-head">
              <div><span class="ci-proj-num">02</span><span class="ci-proj-name">Estrategia de marketing del Q</span></div>
              <div class="ci-proj-resp">Resp: Fede</div>
            </div>
            <div class="ci-status-row">
              <button class="ci-status-btn" data-status="green" type="button">🟢 Verde · en track</button>
              <button class="ci-status-btn selected" data-status="amber" type="button">🟡 Ámbar · con riesgo</button>
              <button class="ci-status-btn" data-status="red" type="button">🔴 Rojo · trabado</button>
            </div>
            <div class="ci-row-inputs">
              <textarea readonly>Cliente clave demora aprobación. Reprogramando lanzamiento a sem 6.</textarea>
              <input type="text" readonly value="Esperando feedback del cliente" />
            </div>
          </div>

          <div class="ci-proj-row">
            <div class="ci-proj-row-head">
              <div><span class="ci-proj-num">03</span><span class="ci-proj-name">Mejora de calidad de feed</span></div>
              <div class="ci-proj-resp">Resp: Juana</div>
            </div>
            <div class="ci-status-row">
              <button class="ci-status-btn selected" data-status="green" type="button">🟢 Verde · en track</button>
              <button class="ci-status-btn" data-status="amber" type="button">🟡 Ámbar · con riesgo</button>
              <button class="ci-status-btn" data-status="red" type="button">🔴 Rojo · trabado</button>
            </div>
            <div class="ci-row-inputs">
              <textarea readonly>Engagement subió 18% vs Q anterior. Nuevo formato funcionando.</textarea>
              <input type="text" readonly value="" />
            </div>
          </div>

          <div class="ci-form-actions">
            <button class="ci-cancel" type="button">Cancelar</button>
            <button class="ci-submit" type="button">Registrar check-in</button>
          </div>
        </div>
      </div>
    `;
    return wrap;
  },

  escapeHtml(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  },
};

window.CascaraCheckIns = CascaraCheckIns;

/* ============================================================
 * CascaraPresentations — manejo del estado "ejemplo / oficial"
 * y generación de la presentación oficial desde DB
 * ============================================================ */
const CascaraPresentations = {
  AREA_TO_PRESO_KEY: {
    contenido: 'contenido', creatividad: 'creatividad', marketing: 'marketing',
    comercial: 'comercial', operaciones: 'operaciones', admin: 'admin', capital: 'capital',
  },

  ensureStyle() {
    if (document.getElementById('cascara-presos-style')) return;
    const s = document.createElement('style');
    s.id = 'cascara-presos-style';
    s.textContent = `
      .preso-mini.is-example, .preso-card.is-example { position: relative; }
      .preso-mini.is-example::after,
      .preso-card.is-example::after {
        content: 'Ejemplo';
        position: absolute; top: 8px; right: 10px;
        background: rgba(195,154,0,0.16); color: #7A6000;
        font-size: 9.5px; font-weight: 700; letter-spacing: 0.1em;
        padding: 2px 8px; border-radius: 999px;
        text-transform: uppercase;
        border: 1px solid rgba(195,154,0,0.35);
      }
      .preso-card.is-example::after { top: 14px; right: 16px; font-size: 10.5px; padding: 3px 10px; }
      .preso-mini.is-approved::after,
      .preso-card.is-approved::after {
        content: 'Oficial · v1';
        position: absolute; top: 8px; right: 10px;
        background: rgba(0,179,107,0.16); color: #00733C;
        font-size: 9.5px; font-weight: 700; letter-spacing: 0.1em;
        padding: 2px 8px; border-radius: 999px;
        text-transform: uppercase;
        border: 1px solid rgba(0,179,107,0.35);
      }
      .preso-card.is-approved::after { top: 14px; right: 16px; font-size: 10.5px; padding: 3px 10px; }

      /* Banner sobre el viewer cuando es ejemplo */
      #cascara-preso-banner {
        position: fixed; top: 0; left: 0; right: 0; z-index: 99996;
        background: rgba(195,154,0,0.95); color: #1C1C1F;
        padding: 10px 20px; text-align: center; font-size: 13px; font-weight: 600;
        letter-spacing: 0.02em; display: none;
        box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      }
      #cascara-preso-banner.visible { display: block; }
      #cascara-preso-banner em { font-style: normal; color: rgba(0,0,0,0.55); margin-left: 6px; font-weight: 400; }

      /* Status selector en admin dashboard */
      .ad-plan-card { position: relative; }
      .ad-status-select {
        margin-top: 12px; width: 100%; padding: 6px 10px;
        border: 1px solid rgba(0,0,0,0.14); border-radius: 8px;
        background: #fff; font-size: 12px; font-weight: 600;
        font-family: 'Helvetica Neue', sans-serif; cursor: pointer;
      }
      .ad-approve-info {
        font-size: 11px; color: #00733C; margin-top: 8px; font-weight: 600;
      }
    `;
    document.head.appendChild(s);
  },

  async refreshMarks() {
    // Las 7 presentaciones son la descripción real de cada área (no ejemplos).
    // Limpiamos cualquier marca residual y no agregamos badges.
    document.querySelectorAll('.preso-mini, .preso-card').forEach(el => {
      el.classList.remove('is-example', 'is-approved');
    });
  },

  presoKeyToAreaSlug(presoKey) {
    // En index.html, las keys (contenido, creatividad, marketing, comercial, operaciones, admin, capital)
    // coinciden con los slugs de mi tabla areas
    return presoKey;
  },

  ensureBanner() {
    if (document.getElementById('cascara-preso-banner')) return;
    const div = document.createElement('div');
    div.id = 'cascara-preso-banner';
    div.innerHTML = 'Estás viendo una presentación de <strong>ejemplo</strong>.<em>La oficial se genera automáticamente cuando el plan del Q queda aprobado.</em>';
    document.body.appendChild(div);
  },

  showBanner() {
    this.ensureBanner();
    document.getElementById('cascara-preso-banner').classList.add('visible');
  },
  hideBanner() {
    const b = document.getElementById('cascara-preso-banner');
    if (b) b.classList.remove('visible');
  },

  async maybeShowExampleBanner(presoKey) {
    if (!Cascara.state.quarter) return;
    const slug = this.presoKeyToAreaSlug(presoKey);
    const { data: plans } = await Cascara.client.from('plans')
      .select('id, status, area:areas(slug)')
      .eq('quarter_id', Cascara.state.quarter.id)
      .in('status', ['approved', 'in_progress', 'closed']);
    const approvedSlugs = new Set((plans || []).map(p => p.area?.slug).filter(Boolean));
    if (approvedSlugs.has(slug)) this.hideBanner();
    else this.showBanner();
  },

  // ---------- GENERAR PRESENTACIÓN OFICIAL ----------
  async openOfficialForArea(areaSlug) {
    if (!Cascara.state.quarter) return null;
    const { data: area } = await Cascara.client.from('areas').select('*').eq('slug', areaSlug).maybeSingle();
    if (!area) return null;
    const { data: plan } = await Cascara.client.from('plans').select('*, director:users!plans_director_user_id_fkey(name)')
      .eq('area_id', area.id).eq('quarter_id', Cascara.state.quarter.id).maybeSingle();
    if (!plan || !['approved', 'in_progress', 'closed'].includes(plan.status)) return null;

    const projects = await Cascara.listProjects(plan.id);
    const team = await Cascara.listTeamMembers(plan.id);
    const articulations = await Cascara.listArticulations(plan.id);
    const months = await Cascara.listCalendarMonths(plan.id);

    CascaraOfficialPreso.render({ area, plan, projects, team, articulations, months, quarter: Cascara.state.quarter });
    return true;
  },
};
window.CascaraPresentations = CascaraPresentations;

/* ============================================================
 * CascaraOfficialPreso — renderiza presentación oficial desde DB
 * Reutiliza el lenguaje visual de .s-slide
 * ============================================================ */
const CascaraOfficialPreso = {
  view: null,
  slideIdx: 0,

  ensureView() {
    if (this.view) return this.view;
    const v = document.createElement('div');
    v.id = 'view-official-preso';
    v.className = 'view';
    v.innerHTML = `
      <div class="op-deck" id="op-deck"></div>
      <div class="s-nav">
        <button class="s-nav-back" onclick="goTo('home')">← Home</button>
        <button id="op-prev">←</button>
        <span class="counter"><span id="op-current">1</span> / <span id="op-total">1</span></span>
        <button id="op-next">→</button>
      </div>
    `;
    document.body.appendChild(v);
    this.view = v;
    this.injectStyle();
    document.getElementById('op-prev').onclick = () => this.show(this.slideIdx - 1);
    document.getElementById('op-next').onclick = () => this.show(this.slideIdx + 1);
    return v;
  },

  injectStyle() {
    if (document.getElementById('cascara-official-preso-style')) return;
    const s = document.createElement('style');
    s.id = 'cascara-official-preso-style';
    s.textContent = `
      #view-official-preso { background: var(--cream, #DBD8D3); }
      #view-official-preso .op-deck { position: relative; width: 100vw; height: 100vh; overflow: hidden; }
      #view-official-preso .s-slide { padding: 6vh 7vw; }
      #view-official-preso .op-proj-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 2vh; }
      #view-official-preso .op-block { background: var(--cream-soft); border-radius: 12px; padding: 16px 18px; border: 1px solid var(--line); }
      #view-official-preso .op-block-lbl { font-size: 11px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: var(--blue); margin-bottom: 6px; }
      #view-official-preso .op-block-val { font-size: 13.5px; line-height: 1.5; color: var(--ink); }
      #view-official-preso .op-kpis { margin-top: 2vh; display: flex; flex-direction: column; gap: 10px; }
      #view-official-preso .op-kpi-row {
        display: grid; grid-template-columns: 1.5fr 0.7fr 0.7fr; gap: 12px;
        background: rgba(255,255,255,0.55); border-radius: 10px;
        padding: 12px 16px; align-items: center; border: 1px solid var(--line);
      }
      #view-official-preso .op-kpi-name { font-weight: 700; font-size: 13.5px; }
      #view-official-preso .op-kpi-tgt { font-size: 12.5px; color: var(--blue); font-weight: 600; }
      #view-official-preso .op-kpi-due { font-size: 12px; color: var(--ink-muted); }
      #view-official-preso .op-team-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 2vh; }
      #view-official-preso .op-team-card { background: var(--cream-soft); border-radius: 12px; padding: 16px 18px; border: 1px solid var(--line); }
      #view-official-preso .op-team-name { font-size: 15px; font-weight: 800; }
      #view-official-preso .op-team-role { font-size: 12.5px; color: var(--ink-muted); margin-bottom: 8px; }
      #view-official-preso .op-team-goal { font-size: 12.5px; color: var(--ink); line-height: 1.5; font-style: italic; }
      #view-official-preso .op-months-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; margin-top: 2vh; }
      #view-official-preso .op-month-card { background: var(--cream-soft); border-radius: 12px; padding: 18px; border: 1px solid var(--line); min-height: 120px; }
      #view-official-preso .op-month-tag { font-family: var(--font-serif); font-style: italic; color: var(--blue); font-size: 18px; margin-bottom: 8px; }
      #view-official-preso .op-month-txt { font-size: 12.5px; line-height: 1.5; color: var(--ink); }
    `;
    document.head.appendChild(s);
  },

  render({ area, plan, projects, team, articulations, months, quarter }) {
    this.ensureView();
    const deck = document.getElementById('op-deck');
    const slides = [];

    // Cover
    slides.push(`
      <section class="s-slide active">
        <img class="s-bg-star" src="assets/brand/cascara-jinete-azul.png" alt="" aria-hidden="true" />
        <div class="s-slide-inner">
          <div class="s-cover-grid">
            <div>
              <div class="s-cover-eyebrow">Cáscara · Plan oficial</div>
              <div class="s-cover-title">${this.escape(area.name)}<em>${this.escape(quarter.name)}.</em></div>
              <div style="font-family:var(--font-serif); font-style:italic; font-size:18px; color:var(--ink-muted); margin-top:18px; max-width:80%; line-height:1.4;">
                Presentación generada automáticamente desde el plan aprobado.
              </div>
            </div>
            <div class="s-meta-grid">
              <div class="s-meta-row"><span class="s-meta-lbl">Área</span><span class="s-meta-val">${this.escape(area.name)}</span></div>
              <div class="s-meta-row"><span class="s-meta-lbl">Director</span><span class="s-meta-val">${this.escape(plan.director?.name || '—')}</span></div>
              <div class="s-meta-row"><span class="s-meta-lbl">Trimestre</span><span class="s-meta-val">${this.escape(quarter.name)}</span></div>
              <div class="s-meta-row"><span class="s-meta-lbl">Proyectos</span><span class="s-meta-val">${projects.length} frentes</span></div>
            </div>
          </div>
        </div>
      </section>
    `);

    // Visión
    slides.push(`
      <section class="s-slide">
        <img class="s-bg-star" src="assets/brand/cascara-jinete-azul.png" alt="" aria-hidden="true" />
        <div class="s-slide-inner">
          <div class="s-slide-tag">I · Visión del área</div>
          <div class="s-section-headline">
            <div class="s-section-title">El norte<br/><span class="accent">del trimestre.</span></div>
          </div>
          <div class="op-block" style="margin-top:2vh;">
            <div class="op-block-lbl">Visión del área</div>
            <div class="op-block-val">${this.escape(plan.vision_text || '—')}</div>
          </div>
          ${plan.vision_macro_text ? `
          <div class="op-block" style="margin-top:14px;">
            <div class="op-block-lbl">Conexión con la visión macro</div>
            <div class="op-block-val">${this.escape(plan.vision_macro_text)}</div>
          </div>` : ''}
        </div>
      </section>
    `);

    // Una slide por proyecto
    projects.forEach((p, i) => {
      const num = String(i + 1).padStart(2, '0');
      slides.push(`
        <section class="s-slide">
          <img class="s-bg-star" src="assets/brand/cascara-jinete-azul.png" alt="" aria-hidden="true" />
          <div class="s-slide-inner">
            <div class="s-slide-tag">II · Proyecto ${num} de ${String(projects.length).padStart(2, '0')}</div>
            <div class="s-section-headline">
              <div class="s-section-title">${this.escape(p.name || 'Sin nombre')}</div>
              <div class="s-section-lead">${this.escape(p.responsible_name ? `Responsable: ${p.responsible_name}` : 'Sin responsable asignado')}${p.subresponsables ? ' · Subresponsables: ' + this.escape(p.subresponsables) : ''}</div>
            </div>
            <div class="op-proj-meta">
              <div class="op-block">
                <div class="op-block-lbl">Hipótesis</div>
                <div class="op-block-val">${this.escape(p.hypothesis || '—')}</div>
              </div>
              <div class="op-block">
                <div class="op-block-lbl">Objetivo del Q</div>
                <div class="op-block-val">${this.escape(p.objective || '—')}</div>
              </div>
              <div class="op-block">
                <div class="op-block-lbl">Por qué es prioridad</div>
                <div class="op-block-val">${this.escape(p.why_priority || '—')}</div>
              </div>
              <div class="op-block">
                <div class="op-block-lbl">Impacto a nivel negocio</div>
                <div class="op-block-val">${this.escape(p.business_impact || '—')}</div>
              </div>
            </div>
            ${(p.kpis && p.kpis.length) ? `
              <div class="op-kpis">
                ${p.kpis.map(k => `
                  <div class="op-kpi-row">
                    <div class="op-kpi-name">${this.escape(k.name || '—')}</div>
                    <div class="op-kpi-tgt">${this.escape(k.target || '')}</div>
                    <div class="op-kpi-due">${this.formatDeadline(k.deadline)}</div>
                  </div>
                `).join('')}
              </div>` : ''}
          </div>
        </section>
      `);
    });

    // Articulación
    if (articulations.length > 0) {
      slides.push(`
        <section class="s-slide">
          <img class="s-bg-star" src="assets/brand/cascara-jinete-azul.png" alt="" aria-hidden="true" />
          <div class="s-slide-inner">
            <div class="s-slide-tag">III · Articulación con otras áreas</div>
            <div class="s-section-headline">
              <div class="s-section-title">Qué entregamos<br/><span class="accent">qué necesitamos.</span></div>
            </div>
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:14px; margin-top:2vh;">
              ${articulations.filter(a => a.what_delivers || a.what_needs).map(a => `
                <div class="op-block">
                  <div class="op-block-lbl">Con ${this.escape(a.with_area?.name || 'área')}</div>
                  ${a.what_delivers ? `<div style="font-size:12px; color:var(--ink-muted); margin-top:6px;">Entregamos: <span style="color:var(--ink);">${this.escape(a.what_delivers)}</span></div>` : ''}
                  ${a.what_needs ? `<div style="font-size:12px; color:var(--ink-muted); margin-top:6px;">Necesitamos: <span style="color:var(--ink);">${this.escape(a.what_needs)}</span></div>` : ''}
                </div>
              `).join('')}
            </div>
          </div>
        </section>
      `);
    }

    // Equipo
    if (team.length > 0) {
      slides.push(`
        <section class="s-slide">
          <img class="s-bg-star" src="assets/brand/cascara-jinete-azul.png" alt="" aria-hidden="true" />
          <div class="s-slide-inner">
            <div class="s-slide-tag">IV · Equipo del Q</div>
            <div class="s-section-headline">
              <div class="s-section-title">Quiénes hacen<br/><span class="accent">que esto pase.</span></div>
            </div>
            <div class="op-team-grid">
              ${team.map(m => `
                <div class="op-team-card">
                  <div class="op-team-name">${this.escape(m.name || '—')}</div>
                  <div class="op-team-role">${this.escape(m.role || '')}${m.dedication ? ' · ' + this.escape(m.dedication) : ''}</div>
                  ${m.goal ? `<div class="op-team-goal">Goal: ${this.escape(m.goal)}</div>` : ''}
                </div>
              `).join('')}
            </div>
            ${plan.presupuesto || plan.herramientas ? `
              <div style="margin-top:2vh; display:grid; grid-template-columns: 1fr 1fr; gap:14px;">
                ${plan.presupuesto ? `<div class="op-block"><div class="op-block-lbl">Presupuesto del Q</div><div class="op-block-val">${this.escape(plan.presupuesto)}</div></div>` : ''}
                ${plan.herramientas ? `<div class="op-block"><div class="op-block-lbl">Herramientas y servicios externos</div><div class="op-block-val">${this.escape(plan.herramientas)}</div></div>` : ''}
              </div>` : ''}
          </div>
        </section>
      `);
    }

    // Calendario
    if (months.length > 0) {
      slides.push(`
        <section class="s-slide">
          <img class="s-bg-star" src="assets/brand/cascara-jinete-azul.png" alt="" aria-hidden="true" />
          <div class="s-slide-inner">
            <div class="s-slide-tag">V · Calendario mes a mes</div>
            <div class="s-section-headline">
              <div class="s-section-title">Cómo se cae<br/><span class="accent">el trimestre.</span></div>
            </div>
            <div class="op-months-grid">
              ${months.map(m => `
                <div class="op-month-card">
                  <div class="op-month-tag">${this.escape(m.month_label || '')}</div>
                  <div class="op-month-txt">${this.escape(m.milestones || '—')}</div>
                </div>
              `).join('')}
            </div>
          </div>
        </section>
      `);
    }

    // Cierre
    slides.push(`
      <section class="s-slide dark">
        <div class="s-slide-inner">
          <div class="s-slide-tag">VI · Cierre</div>
          <div class="s-section-headline">
            <div class="s-section-title">${this.escape(area.name)}<br/><span class="accent">listo para ejecutar.</span></div>
            <div class="s-section-lead">Plan aprobado · check-ins quincenales · retro al cierre</div>
          </div>
          <div style="margin-top:3vh; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.12); border-radius:14px; padding:24px 26px;">
            <div style="font-size:11px; font-weight:800; letter-spacing:0.16em; text-transform:uppercase; color:#AEB6FF; margin-bottom:10px;">Próximos pasos</div>
            <ul style="margin:0; padding-left:18px; font-size:14px; color:white; line-height:1.7;">
              <li>El equipo del área se junta cada 2 semanas a completar check-ins.</li>
              <li>Teo audita los check-ins en el dashboard global.</li>
              <li>Al cierre del Q, cada Responsable hace la retro de sus Proyectos.</li>
            </ul>
          </div>
        </div>
      </section>
    `);

    deck.innerHTML = slides.join('\n');
    document.getElementById('op-total').textContent = slides.length;
    this.slideIdx = 0;
    this.show(0);
  },

  show(i) {
    const slides = this.view.querySelectorAll('.s-slide');
    if (!slides.length) return;
    this.slideIdx = Math.max(0, Math.min(slides.length - 1, i));
    slides.forEach((s, n) => s.classList.toggle('active', n === this.slideIdx));
    document.getElementById('op-current').textContent = this.slideIdx + 1;
  },

  escape(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  },
  formatDeadline(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  },
};
window.CascaraOfficialPreso = CascaraOfficialPreso;

/* ============================================================
 * CascaraAudit — Sesión de Auditoría del Strategy Council
 * Drag&drop de Proyectos a las 6 quincenas del Q
 * ============================================================ */
const CascaraAudit = {
  view: null,
  dragState: null,

  ensureView() {
    if (this.view) return this.view;
    this.injectStyle();
    const v = document.createElement('div');
    v.id = 'view-audit-session';
    v.className = 'view';
    v.innerHTML = `
      <div class="au-wrap">
        <button class="ext-back" onclick="goTo('home')">← Volver al home</button>
        <div class="au-head-row">
          <div class="au-head">
            <div class="au-eyebrow">Strategy Council · Audit Session</div>
            <h1 class="au-title">Master <em>Timeline.</em></h1>
            <div class="au-sub">Arrastrá cada Proyecto a la quincena del Q donde arranca. Cuando esté ordenado, locká el timeline.</div>
          </div>
          <div class="au-status-controls" id="au-status-controls"></div>
        </div>

        <div class="au-board">
          <div class="au-pool-col">
            <div class="au-col-head">
              <div class="au-col-title">Sin asignar</div>
              <div class="au-col-sub" id="au-pool-count">0 proyectos</div>
            </div>
            <div class="au-drop-zone" data-fortnight="0" id="au-pool-drop">
              <div class="au-empty">Todos asignados ✓</div>
            </div>
          </div>

          <div class="au-fortnights-grid" id="au-fortnights-grid"></div>
        </div>
      </div>
    `;
    document.body.appendChild(v);
    this.view = v;
    return v;
  },

  injectStyle() {
    if (document.getElementById('cascara-audit-style')) return;
    const s = document.createElement('style');
    s.id = 'cascara-audit-style';
    s.textContent = `
      #view-audit-session { background: var(--cream, #DBD8D3); min-height: 100vh; padding: 36px 40px 60px; font-family: var(--font-sans); }
      #view-audit-session .au-wrap { max-width: 1500px; margin: 0 auto; }
      #view-audit-session .ext-back { background: none; border: none; color: #52525A; cursor: pointer; font-size: 13px; padding: 0; margin-bottom: 24px; font-family: inherit; }
      #view-audit-session .au-head-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin-bottom: 28px; }
      #view-audit-session .au-eyebrow { font-size: 11px; color: #C39A00; text-transform: uppercase; letter-spacing: 0.16em; font-weight: 700; margin-bottom: 12px; }
      #view-audit-session .au-title { font-size: 52px; font-weight: 800; margin: 0 0 8px; color: #0A0A0C; line-height: 0.95; letter-spacing: -0.025em; }
      #view-audit-session .au-title em { font-family: var(--font-serif); font-style: italic; color: var(--blue); font-weight: 400; }
      #view-audit-session .au-sub { font-size: 14px; color: #52525A; max-width: 700px; line-height: 1.5; }

      .au-status-controls { display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
      .au-status-badge { padding: 6px 14px; border-radius: 999px; font-size: 11.5px; font-weight: 700; letter-spacing: 0.06em; }
      .au-status-badge.planning { background: rgba(82,82,90,0.12); color: #52525A; }
      .au-status-badge.in_progress { background: rgba(195,154,0,0.16); color: #7A6000; }
      .au-status-badge.locked { background: rgba(0,179,107,0.14); color: #00733C; }
      .au-action-btn {
        background: var(--blue); color: #fff; border: none;
        padding: 10px 18px; border-radius: 999px;
        font-size: 12.5px; font-weight: 600; cursor: pointer;
        font-family: inherit; letter-spacing: 0.02em;
      }
      .au-action-btn.lock { background: #00B36B; }
      .au-action-btn.unlock { background: transparent; color: var(--ink-soft); border: 1px solid rgba(0,0,0,0.18); }
      .au-action-btn:hover { filter: brightness(1.08); }

      /* Board layout: pool left + fortnights grid right */
      .au-board {
        display: grid;
        grid-template-columns: 260px 1fr;
        gap: 18px;
        align-items: start;
      }

      .au-pool-col {
        background: rgba(0,0,0,0.04);
        border-radius: 14px;
        padding: 16px;
        position: sticky; top: 20px;
        max-height: calc(100vh - 60px);
        overflow-y: auto;
      }
      .au-fortnights-grid {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: 12px;
      }
      .au-fortnight-col {
        background: rgba(255,255,255,0.6);
        border: 1px solid rgba(0,0,0,0.07);
        border-radius: 14px;
        padding: 14px 12px;
        min-height: 400px;
        display: flex; flex-direction: column;
      }
      .au-col-head { padding-bottom: 12px; border-bottom: 1px solid rgba(0,0,0,0.08); margin-bottom: 12px; }
      .au-col-title { font-size: 13px; font-weight: 800; letter-spacing: -0.01em; }
      .au-col-sub { font-size: 10.5px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #52525A; margin-top: 4px; }
      .au-col-dates { font-family: var(--font-serif); font-style: italic; font-size: 11px; color: var(--blue); margin-top: 2px; }

      .au-drop-zone {
        flex: 1;
        display: flex; flex-direction: column; gap: 8px;
        min-height: 50px;
        padding: 4px;
        border-radius: 8px;
        transition: background 0.15s ease;
      }
      .au-drop-zone.is-dragover {
        background: rgba(16,6,159,0.08);
        outline: 2px dashed var(--blue);
        outline-offset: -2px;
      }
      .au-empty {
        font-size: 11px; color: #A8A8AC;
        text-align: center; padding: 14px;
        font-style: italic; font-family: var(--font-serif);
      }

      .au-project-chip {
        background: #fff;
        border: 1px solid rgba(0,0,0,0.1);
        border-left: 3px solid var(--area-color, var(--blue));
        border-radius: 8px;
        padding: 10px 12px;
        cursor: grab;
        user-select: none;
        transition: transform 0.12s ease, box-shadow 0.12s ease, border-color 0.12s ease;
      }
      .au-project-chip:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.08); transform: translateY(-1px); }
      .au-project-chip:active { cursor: grabbing; }
      .au-project-chip.is-dragging { opacity: 0.4; }
      .au-project-area {
        font-size: 9.5px; font-weight: 800; letter-spacing: 0.14em;
        text-transform: uppercase; color: var(--area-color, var(--blue));
        margin-bottom: 3px;
      }
      .au-project-name {
        font-size: 12.5px; font-weight: 600; line-height: 1.3; color: var(--ink);
      }
      .au-project-resp {
        font-size: 10.5px; color: #52525A; margin-top: 4px;
        font-family: var(--font-serif); font-style: italic;
      }

      /* Locked state */
      #view-audit-session.is-locked .au-project-chip { cursor: not-allowed; opacity: 0.85; }
      #view-audit-session.is-locked .au-drop-zone.is-dragover { outline: none; background: transparent; }

      .au-pool-count-badge {
        background: var(--blue); color: #fff;
        padding: 2px 8px; border-radius: 999px;
        font-size: 10px; font-weight: 700;
        display: inline-block; margin-left: 6px;
      }
    `;
    document.head.appendChild(s);
  },

  async enter() {
    if (!Cascara.state.user) {
      alert('Necesitás estar logueado.');
      goTo('login');
      return;
    }
    const isSC = await Cascara.isStrategyCouncil();
    const isAdmin = Cascara.isAdmin();
    if (!isSC && !isAdmin) {
      alert('Esta vista es solo para el Strategy Council (Teo, Facu, Franco).');
      goTo('home');
      return;
    }

    this.ensureView();
    await this.render();
  },

  async render() {
    const status = await Cascara.getAuditStatus();
    if (Cascara.state.quarter) Cascara.state.quarter.audit_status = status;

    // Render status controls + locked class
    const view = document.getElementById('view-audit-session');
    view.classList.toggle('is-locked', status === 'timeline_locked');

    const statusControls = document.getElementById('au-status-controls');
    const statusLabel = {
      planning: 'Sin abrir',
      audit_in_progress: 'En curso',
      timeline_locked: 'Locked ✓',
      execution: 'En ejecución',
      closed: 'Cerrado',
    }[status] || status;
    const statusKey = status === 'audit_in_progress' ? 'in_progress' : (status === 'timeline_locked' || status === 'execution' || status === 'closed' ? 'locked' : 'planning');

    let actionBtn = '';
    if (status === 'planning') {
      actionBtn = '<button class="au-action-btn" onclick="CascaraAudit.startSession()">Abrir Audit Session</button>';
    } else if (status === 'audit_in_progress') {
      actionBtn = '<button class="au-action-btn lock" onclick="CascaraAudit.lockTimeline()">Lock Master Timeline</button>';
    } else if (status === 'timeline_locked') {
      actionBtn = '<button class="au-action-btn unlock" onclick="CascaraAudit.unlockTimeline()">Reabrir para ajustes</button>';
    }
    statusControls.innerHTML = `
      <div class="au-status-badge ${statusKey}">${statusLabel}</div>
      ${actionBtn}
    `;

    // Load projects + timeline entries
    const projects = await Cascara.listProjectsForAudit();
    const entries = await Cascara.listTimelineEntries();
    const entryByProject = new Map(entries.map(e => [e.project_id, e]));

    // Render fortnights grid
    const fortnights = CascaraForm.deriveFortnightsFromQuarter(Cascara.state.quarter);
    const grid = document.getElementById('au-fortnights-grid');
    grid.innerHTML = '';
    fortnights.forEach((fn, i) => {
      const idx = i + 1;
      const col = document.createElement('div');
      col.className = 'au-fortnight-col';
      col.innerHTML = `
        <div class="au-col-head">
          <div class="au-col-title">Q${String(idx).padStart(2,'0')} · ${fn.label.split('·')[1]?.trim() || fn.label}</div>
          <div class="au-col-dates">${fn.dateLabel || ''}</div>
        </div>
        <div class="au-drop-zone" data-fortnight="${idx}"></div>
      `;
      grid.appendChild(col);
    });

    // Place projects in their assigned column (or pool)
    const pool = document.getElementById('au-pool-drop');
    pool.innerHTML = '';
    projects.forEach(p => {
      const chip = this.buildProjectChip(p);
      const entry = entryByProject.get(p.id);
      if (entry && entry.start_fortnight) {
        const target = grid.querySelector(`.au-drop-zone[data-fortnight="${entry.start_fortnight}"]`);
        if (target) target.appendChild(chip);
      } else {
        pool.appendChild(chip);
      }
    });

    // Update pool count + empty messages
    this.updateCounts();

    // Wire drop zones (allow drops if not locked)
    if (status !== 'timeline_locked' && status !== 'execution' && status !== 'closed') {
      this.wireDragDrop();
    }
  },

  buildProjectChip(p) {
    const chip = document.createElement('div');
    chip.className = 'au-project-chip';
    chip.draggable = true;
    chip.dataset.projectId = p.id;
    chip.style.setProperty('--area-color', p.area_color || '#10069F');
    chip.innerHTML = `
      <div class="au-project-area">${this.escape(p.area_name || '')}</div>
      <div class="au-project-name">${this.escape(p.name || 'Sin nombre')}</div>
      ${p.responsible_name ? `<div class="au-project-resp">Resp: ${this.escape(p.responsible_name)}</div>` : ''}
    `;
    chip.addEventListener('dragstart', (e) => {
      this.dragState = { projectId: p.id, fromEl: chip };
      chip.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', p.id);
    });
    chip.addEventListener('dragend', () => {
      chip.classList.remove('is-dragging');
      this.dragState = null;
    });
    return chip;
  },

  wireDragDrop() {
    document.querySelectorAll('#view-audit-session .au-drop-zone').forEach(zone => {
      zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        zone.classList.add('is-dragover');
      });
      zone.addEventListener('dragleave', (e) => {
        if (e.target === zone) zone.classList.remove('is-dragover');
      });
      zone.addEventListener('drop', async (e) => {
        e.preventDefault();
        zone.classList.remove('is-dragover');
        if (!this.dragState) return;
        const { projectId, fromEl } = this.dragState;
        const fortnight = parseInt(zone.dataset.fortnight);
        // Remover empty placeholder si lo hubiera
        const empty = zone.querySelector('.au-empty');
        if (empty) empty.remove();
        // Mover chip al nuevo zone
        zone.appendChild(fromEl);
        // Persistir
        if (fortnight === 0) {
          // Dropped al pool: borrar entrada del timeline
          await Cascara.client.from('q_timeline').delete()
            .eq('quarter_id', Cascara.state.quarter.id).eq('project_id', projectId);
        } else {
          await Cascara.upsertTimelineEntry(projectId, fortnight, fortnight, 0);
        }
        this.updateCounts();
      });
    });
  },

  updateCounts() {
    const pool = document.getElementById('au-pool-drop');
    const poolItems = pool.querySelectorAll('.au-project-chip');
    document.getElementById('au-pool-count').textContent = `${poolItems.length} proyecto${poolItems.length === 1 ? '' : 's'}`;
    if (poolItems.length === 0 && !pool.querySelector('.au-empty')) {
      pool.innerHTML = '<div class="au-empty">Todos asignados ✓</div>';
    }
    // Empty messages para las quincenas
    document.querySelectorAll('#view-audit-session .au-fortnight-col .au-drop-zone').forEach(zone => {
      const chips = zone.querySelectorAll('.au-project-chip');
      const empty = zone.querySelector('.au-empty');
      if (chips.length === 0 && !empty) {
        const e = document.createElement('div');
        e.className = 'au-empty';
        e.textContent = '—';
        zone.appendChild(e);
      } else if (chips.length > 0 && empty) {
        empty.remove();
      }
    });
  },

  async startSession() {
    await Cascara.setAuditStatus('audit_in_progress');
    await this.render();
  },

  async lockTimeline() {
    // Confirmar
    const unassigned = document.querySelectorAll('#au-pool-drop .au-project-chip').length;
    if (unassigned > 0) {
      if (!confirm(`Todavía hay ${unassigned} proyecto${unassigned === 1 ? '' : 's'} sin asignar. ¿Lockear igual?`)) return;
    }
    if (!confirm('Lockear el Master Timeline desbloquea la Capa 2 para todos los Directores. ¿Confirmás?')) return;
    await Cascara.setAuditStatus('timeline_locked');
    await this.render();
    alert('Master Timeline locked. Los Directores ya pueden completar la Capa 2.');
  },

  async unlockTimeline() {
    if (!confirm('Reabrir la Audit Session vuelve la Capa 2 a estado bloqueado para todos los Directores. Las fechas ya cargadas NO se borran. ¿Continuar?')) return;
    await Cascara.setAuditStatus('audit_in_progress');
    await this.render();
  },

  escape(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  },
};
window.CascaraAudit = CascaraAudit;

/* ============================================================
 * CascaraExport — descarga el plan en JSON (para Claude u otros) o lo imprime como PDF
 * ============================================================ */
const CascaraExport = {
  async collectPlanData() {
    const plan = Cascara.state.plan;
    const area = Cascara.state.area;
    const quarter = Cascara.state.quarter;
    if (!plan || !area) return null;

    const [projects, team, articulations, months, milestones, kpis] = await Promise.all([
      Cascara.client.from('projects').select('*').eq('plan_id', plan.id).order('order_index'),
      Cascara.client.from('team_members').select('*').eq('plan_id', plan.id),
      Cascara.client.from('articulations').select('*, with_area:areas(name, slug)').eq('plan_id', plan.id),
      Cascara.client.from('calendar_months').select('*').eq('plan_id', plan.id),
      // milestones de cualquier proyecto del plan
      Cascara.client.from('project_milestones').select('*'),
      Cascara.client.from('kpis').select('*'),
    ]);

    const projIds = new Set((projects.data || []).map(p => p.id));
    const projMs = (milestones.data || []).filter(m => projIds.has(m.project_id));
    const projKpis = (kpis.data || []).filter(k => projIds.has(k.project_id));

    return {
      meta: {
        exported_at: new Date().toISOString(),
        area: { name: area.name, slug: area.slug },
        quarter: quarter ? { name: quarter.name, start_date: quarter.start_date, audit_status: quarter.audit_status } : null,
        director: Cascara.state.user?.name,
      },
      plan: {
        status: plan.status,
        presentation_date: plan.presentation_date,
        vision_text: plan.vision_text,
        learnings_text: plan.learnings_text,
        not_doing_text: plan.not_doing_text,
        ceo_coo_request: plan.ceo_coo_request,
        fortnight_notes: plan.fortnight_notes,
        budget: plan.budget,
        hiring_plan: plan.hiring_plan,
        tools_services: plan.tools_services,
        // campos marketing-only (si el plan es de marketing, vienen llenos)
        marketing: area.slug === 'marketing' ? {
          tesis_narrativa: plan.mkt_tesis_narrativa,
          tesis_hipotesis: plan.mkt_tesis_hipotesis,
          tesis_no_haremos: plan.mkt_tesis_no_haremos,
          audiencias: plan.mkt_audiencias,
          mensajes: plan.mkt_mensajes,
          tonalidad: plan.mkt_tonalidad,
          directivas_contenido: plan.mkt_directivas_contenido,
          directivas_comercial: plan.mkt_directivas_comercial,
          directivas_marcas: plan.mkt_directivas_marcas,
          auditoria_monitoreo: plan.mkt_auditoria_monitoreo,
          auditoria_hallazgos: plan.mkt_auditoria_hallazgos,
          producto_cascara: plan.mkt_producto_cascara,
          producto_cascarita: plan.mkt_producto_cascarita,
          producto_decisiones: plan.mkt_producto_decisiones,
        } : null,
      },
      projects: (projects.data || []).map(p => ({
        name: p.name,
        responsible_name: p.responsible_name,
        subresponsables: p.subresponsables,
        scope_execution: p.scope_execution,
        hypothesis: p.hypothesis,
        objective: p.objective,
        why_priority: p.why_priority,
        business_impact: p.business_impact,
        risks: p.risks,
        launch_type: p.launch_type,
        time_window: p.time_window,
        kpi_summary: p.kpi_summary,
        milestones: projMs.filter(m => m.project_id === p.id).map(m => ({ title: m.title, due_date: m.due_date, status: m.status })),
        kpis: projKpis.filter(k => k.project_id === p.id).map(k => ({ name: k.name, target: k.target, deadline: k.deadline })),
      })),
      team: (team.data || []).map(m => ({ name: m.name, dedication: m.dedication, personal_goal: m.personal_goal, role_in_q: m.role_in_q })),
      articulations: (articulations.data || []).map(a => ({ with_area: a.with_area?.name, what_needs: a.what_needs, what_delivers: a.what_delivers })),
      calendar: (months.data || []).map(c => ({ month: c.month, milestones: c.milestones })),
    };
  },

  async downloadJSON() {
    const data = await this.collectPlanData();
    if (!data) { alert('No hay plan cargado para exportar.'); return; }
    const area = data.meta.area.slug;
    const q = data.meta.quarter?.name || 'sin-q';
    const stamp = new Date().toISOString().slice(0, 10);
    const fname = `plan-${area}-${q}-${stamp}.json`;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname; document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  },

  printPDF() {
    // Inyectar print stylesheet temporal que limpia chrome y deja solo el contenido del form
    let style = document.getElementById('cascara-print-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'cascara-print-style';
      style.media = 'print';
      style.textContent = `
        @page { size: A4; margin: 18mm; }
        body * { visibility: hidden; }
        #view-formulario, #view-formulario * { visibility: visible; }
        #view-formulario { position: absolute; left: 0; top: 0; width: 100%; background: #fff !important; }
        .fg-topbar, .fg-nav, .fg-actions, .fg-progress-card, .fg-footer-nav, .cascara-comments-marker, .cascara-comments-panel, .fg-back { display: none !important; }
        .f-section { page-break-inside: avoid; break-inside: avoid; background: #fff !important; border: 1px solid #ccc !important; margin-bottom: 14px !important; padding: 16px !important; }
        .f-field-help { color: #555 !important; }
        textarea, input, select { border: 0 !important; background: transparent !important; padding: 2px 0 !important; resize: none !important; }
        .f-resp-add, .f-kpi-add, .f-milestone-add, .f-dep-add, .f-btn-add { display: none !important; }
        .f-resp-remove, .f-kpi-remove, .mkt-launch-del { display: none !important; }
        .required, .f-section-status { display: none !important; }
        h1, .f-section-title { color: #10069F !important; }
      `;
      document.head.appendChild(style);
    }
    window.print();
  },
};
window.CascaraExport = CascaraExport;

/* ============================================================
 * CascaraFormMarketing — form especial para el área de Marketing
 * Es un DOCUMENTO ESTRATÉGICO del Q, no una lista de proyectos.
 * Marketing dirige el QUÉ del ecosistema; sus directivas se distribuyen
 * en los planes de Contenido / Comercial / Marcas founders.
 * ============================================================ */
const CascaraFormMarketing = {
  injected: false,
  saveTimer: null,

  async enter() {
    // Ocultar form estándar (nav + contenido)
    const view = document.getElementById('view-formulario');
    if (!view) return;
    const std = view.querySelector('.fg-nav');
    if (std) std.style.display = 'none';
    const stdContent = view.querySelector('.fg-content');
    if (stdContent) stdContent.style.display = 'none';

    // Update topbar / header
    const metaArea = document.getElementById('fg-meta-area');
    if (metaArea) metaArea.textContent = Cascara.state.area.name;
    const metaDir = document.getElementById('fg-meta-director');
    if (metaDir) metaDir.textContent = Cascara.state.user.name.split(' ')[0];
    const titleEl = view.querySelector('.fg-title');
    if (titleEl) titleEl.innerHTML = 'Documento estratégico<em>del Q.</em>';
    const leadEl = view.querySelector('.fg-lead');
    if (leadEl) leadEl.textContent = 'Marketing no carga proyectos sueltos: define el QUÉ del Q completo. Esta tesis baja como directivas a Contenido, Comercial y Marcas founders.';

    // Inyectar nuestro contenido custom una sola vez
    let mktRoot = document.getElementById('mkt-form-root');
    if (!mktRoot) {
      mktRoot = document.createElement('div');
      mktRoot.id = 'mkt-form-root';
      mktRoot.className = 'mkt-form-root';
      const parent = view.querySelector('.form-glass-app');
      if (parent) parent.appendChild(mktRoot);
    }
    mktRoot.style.display = '';
    mktRoot.innerHTML = this.template();

    // Inyectar estilos una vez
    this.injectStyles();

    // Banner de audit/comentarios igual que en el form estándar
    CascaraForm.renderAuditBanner?.();

    // Poblar valores del plan existente
    await this.populate();

    // Wire bindings: auto-save de textareas + Lanzamientos
    this.bindAutoSave();
    await this.renderLanzamientos();
    await this.renderArticulaciones();
  },

  teardown() {
    const mktRoot = document.getElementById('mkt-form-root');
    if (mktRoot) mktRoot.style.display = 'none';
    const view = document.getElementById('view-formulario');
    if (!view) return;
    const std = view.querySelector('.fg-nav');
    if (std) std.style.display = '';
    const stdContent = view.querySelector('.fg-content');
    if (stdContent) stdContent.style.display = '';
    // Restaurar título estándar
    const titleEl = view.querySelector('.fg-title');
    if (titleEl) titleEl.innerHTML = 'Planificación<em>de tu área.</em>';
    const leadEl = view.querySelector('.fg-lead');
    if (leadEl) leadEl.textContent = 'Completá una sola vez al inicio del Q. La misma plantilla para todas las áreas. Se firma con el CEO en la reunión de apertura.';
  },

  template() {
    const u = Cascara.state.user;
    const q = Cascara.state.quarter;
    return `
      <!-- NAV PILLS MARKETING -->
      <div class="fg-nav mkt-nav">
        <button class="fg-pill active" data-target="mfs1"><span class="fg-pill-num">01</span><span>Identidad</span></button>
        <button class="fg-pill" data-target="mfs2"><span class="fg-pill-num">02</span><span>Tesis del Q</span></button>
        <button class="fg-pill" data-target="mfs3"><span class="fg-pill-num">03</span><span>Audiencias y mensajes</span></button>
        <button class="fg-pill" data-target="mfs4"><span class="fg-pill-num">04</span><span>Lanzamientos</span></button>
        <button class="fg-pill" data-target="mfs5"><span class="fg-pill-num">05</span><span>Directivas</span></button>
        <button class="fg-pill" data-target="mfs6"><span class="fg-pill-num">06</span><span>Auditoría Comercial</span></button>
        <button class="fg-pill" data-target="mfs7"><span class="fg-pill-num">07</span><span>Producto B2C</span></button>
        <button class="fg-pill" data-target="mfs8"><span class="fg-pill-num">08</span><span>Articulación</span></button>
      </div>

      <div class="fg-content mkt-content">

        <!-- 01 · IDENTIDAD -->
        <section class="f-section" id="mfs1">
          <div class="f-section-head">
            <div class="f-section-num">01</div>
            <div class="f-section-title-block">
              <div class="f-section-title">Identidad <em>del plan.</em></div>
              <div class="f-section-sub">Quién dirige, en qué Q, fecha de presentación al CEO.</div>
            </div>
          </div>
          <div class="f-fields-grid">
            <div class="f-field readonly">
              <label class="f-field-label">Director</label>
              <div class="f-field-static">${u?.name || '—'}</div>
            </div>
            <div class="f-field readonly">
              <label class="f-field-label">Área</label>
              <div class="f-field-static">Growth & Marketing</div>
            </div>
            <div class="f-field readonly">
              <label class="f-field-label">Trimestre</label>
              <div class="f-field-static">${q?.name || '—'}</div>
            </div>
            <div class="f-field">
              <label class="f-field-label">Fecha de presentación al CEO</label>
              <input type="date" data-field="presentation_date" data-target="plan" class="f-field-input" />
              <div class="f-field-help">La fecha en que vas a defender esta tesis frente a Teo y Facu. Idealmente la apertura del Q.</div>
            </div>
          </div>
        </section>

        <!-- 02 · TESIS DEL Q -->
        <section class="f-section" id="mfs2">
          <div class="f-section-head">
            <div class="f-section-num">02</div>
            <div class="f-section-title-block">
              <div class="f-section-title">Tesis <em>del Q.</em></div>
              <div class="f-section-sub">La brújula. Lo que va a guiar las decisiones de Contenido, Comercial y Marcas founders durante todo el trimestre.</div>
            </div>
          </div>

          <div class="f-field">
            <label class="f-field-label">Narrativa macro del Q</label>
            <textarea data-field="mkt_tesis_narrativa" data-target="plan" class="f-field-textarea" rows="3" placeholder="Ej: Este Q hablamos de cómo el founder de B2B escala su voz sin perder autoría. Mostramos sistemas, no solo resultados."></textarea>
            <div class="f-field-help"><strong>¿Cuál es la historia que Cáscara cuenta este trimestre?</strong> Una idea en 2-3 oraciones que sirva de brújula para todo el equipo. Es lo que cualquiera del equipo debería poder repetir si le preguntás de qué va el Q.</div>
          </div>

          <div class="f-field">
            <label class="f-field-label">Hipótesis de mercado / momento</label>
            <textarea data-field="mkt_tesis_hipotesis" data-target="plan" class="f-field-textarea" rows="3" placeholder="Ej: Los founders B2B están saturados de contenido performático y empiezan a buscar voces con criterio. Es el momento de mostrar autoridad técnica con personalidad."></textarea>
            <div class="f-field-help"><strong>¿Qué estamos leyendo del contexto que justifica esta narrativa?</strong> Tendencia del mercado, dolor que detectamos, ventana de oportunidad. Si la hipótesis falla, vamos a saber por qué corregir el rumbo.</div>
          </div>

          <div class="f-field">
            <label class="f-field-label">Lo que NO vamos a hacer este Q</label>
            <textarea data-field="mkt_tesis_no_haremos" data-target="plan" class="f-field-textarea" rows="3" placeholder="Ej: No hacemos contenido de hooks virales. No salimos a B2C nuevo. No abrimos partnerships con agencias de marketing tradicional."></textarea>
            <div class="f-field-help"><strong>Decisiones explícitas de descarte.</strong> Temas, audiencias o productos que están afuera este Q. Sirve para frenar pedidos del equipo y mantener foco. Si no hay nada acá, probablemente el foco esté difuso.</div>
          </div>
        </section>

        <!-- 03 · AUDIENCIAS Y MENSAJES -->
        <section class="f-section" id="mfs3">
          <div class="f-section-head">
            <div class="f-section-num">03</div>
            <div class="f-section-title-block">
              <div class="f-section-title">Audiencias y <em>mensajes.</em></div>
              <div class="f-section-sub">A quiénes le hablamos y qué les decimos este Q.</div>
            </div>
          </div>

          <div class="f-field">
            <label class="f-field-label">Audiencias prioritarias del Q</label>
            <textarea data-field="mkt_audiencias" data-target="plan" class="f-field-textarea" rows="4" placeholder="Ej:&#10;1. Founders B2B (50k+ MRR) que quieren escalar contenido sin perder autoría&#10;2. Marketers internos de SaaS que buscan referentes de criterio&#10;3. Founders que vienen del producto y están aprendiendo a comunicar"></textarea>
            <div class="f-field-help"><strong>2 o 3 audiencias prioritarias, con descriptor concreto.</strong> Evitá generalidades. No "founders B2B" a secas — algo como "founders B2B que ya facturan +50k MRR y quieren escalar contenido". Mientras más nítida la audiencia, más fácil le resulta a Contenido construir las piezas.</div>
          </div>

          <div class="f-field">
            <label class="f-field-label">Mensajes y temas centrales del Q</label>
            <textarea data-field="mkt_mensajes" data-target="plan" class="f-field-textarea" rows="4" placeholder="Ej:&#10;1. La autoría no se delega, se sistematiza&#10;2. El founder es el sistema operativo de su marca&#10;3. Crecer sin perder voz se diseña, no se improvisa"></textarea>
            <div class="f-field-help"><strong>3 o 4 ideas que vamos a defender este Q.</strong> Estos son los pilares conceptuales sobre los que Contenido construye piezas, Comercial arma el pitch, y las Marcas founders modulan su voz. Cada idea debería poder leerse aislada y tener sentido.</div>
          </div>

          <div class="f-field">
            <label class="f-field-label">Tonalidad y posicionamiento del Q</label>
            <textarea data-field="mkt_tonalidad" data-target="plan" class="f-field-textarea" rows="3" placeholder="Ej: Autoridad técnica con ironía. Maestros que comparten lo que aprendieron, sin pose ni performance."></textarea>
            <div class="f-field-help"><strong>¿Desde qué lugar habla Cáscara este Q?</strong> No es el tono permanente — es el énfasis específico del trimestre. Esto guía cómo Contenido escribe captions, cómo Comercial conversa, cómo las Marcas founders modulan su registro.</div>
          </div>
        </section>

        <!-- 04 · LANZAMIENTOS DEL Q (= Proyectos · van al Master Timeline) -->
        <section class="f-section" id="mfs4">
          <div class="f-section-head">
            <div class="f-section-num">04</div>
            <div class="f-section-title-block">
              <div class="f-section-title">Lanzamientos <em>del Q.</em></div>
              <div class="f-section-sub">Estos sí son Proyectos formales: productos, campañas o activaciones que tienen ventana de ejecución. Van al Master Timeline en la Audit Session.</div>
            </div>
          </div>

          <div class="mkt-launches" id="mkt-launches-list">
            <div class="f-empty">Cargando lanzamientos…</div>
          </div>
          <button type="button" class="f-btn-add" id="mkt-add-launch">+ Agregar lanzamiento</button>
        </section>

        <!-- 05 · DIRECTIVAS A OTRAS ÁREAS -->
        <section class="f-section" id="mfs5">
          <div class="f-section-head">
            <div class="f-section-num">05</div>
            <div class="f-section-title-block">
              <div class="f-section-title">Directivas a <em>otras áreas.</em></div>
              <div class="f-section-sub">El output principal de Marketing. Son inputs concretos que aparecen como contexto en los planes de Contenido, Comercial y Marcas founders.</div>
            </div>
          </div>

          <div class="f-field">
            <label class="f-field-label">A Contenido</label>
            <textarea data-field="mkt_directivas_contenido" data-target="plan" class="f-field-textarea" rows="5" placeholder="Ej:&#10;— Construí 3 piezas que profundicen en 'autoría sistematizada' (largo formato + carrusel)&#10;— Prioridad: video largo con Facu sobre el sistema operativo de un founder&#10;— No hacer: hooks aspiracionales genéricos"></textarea>
            <div class="f-field-help"><strong>Bajada concreta para Fede:</strong> qué temas debe construir, qué piezas son imprescindibles, qué formatos priorizar este Q, qué evitar. Esto se traduce en los Proyectos de Contenido. Cuanto más específica la directiva, menos fricción después.</div>
          </div>

          <div class="f-field">
            <label class="f-field-label">A Comercial</label>
            <textarea data-field="mkt_directivas_comercial" data-target="plan" class="f-field-textarea" rows="4" placeholder="Ej:&#10;— Messaging de discovery: arrancar desde 'sistema' no desde 'contenido'&#10;— Calificación: priorizar leads con equipo de marketing interno&#10;— Filtrar: leads sin equipo aún se mandan a Cascarita"></textarea>
            <div class="f-field-help"><strong>Bajada concreta para Francisca:</strong> qué messaging sostener en discovery + qué criterios de calidad de lead estamos privilegiando este Q. Sirve para que la conversación de venta esté alineada con la narrativa.</div>
          </div>

          <div class="f-field">
            <label class="f-field-label">A Marcas founders (Facu / Fede / Juana)</label>
            <textarea data-field="mkt_directivas_marcas" data-target="plan" class="f-field-textarea" rows="5" placeholder="Ej:&#10;— Facu: estrategia de growth para founders B2B (autoridad técnica)&#10;— Fede: el sistema operativo de un creator (cómo se organiza el back)&#10;— Juana: producción visual con criterio de marca (poco volumen, alta densidad)"></textarea>
            <div class="f-field-help"><strong>El ángulo específico de cada founder este Q.</strong> Cada uno tiene su voz, pero hay un énfasis que define el trimestre. Esto guía a Contenido cuando construye piezas con cada uno y le da coherencia al ecosistema.</div>
          </div>
        </section>

        <!-- 06 · AUDITORÍA COMERCIAL -->
        <section class="f-section" id="mfs6">
          <div class="f-section-head">
            <div class="f-section-num">06</div>
            <div class="f-section-title-block">
              <div class="f-section-title">Auditoría sobre <em>Comercial.</em></div>
              <div class="f-section-sub">Marketing no dirige a Comercial, lo audita. Acá registrás qué estás observando del proceso comercial este Q.</div>
            </div>
          </div>

          <div class="f-field">
            <label class="f-field-label">Qué estoy monitoreando este Q</label>
            <textarea data-field="mkt_auditoria_monitoreo" data-target="plan" class="f-field-textarea" rows="4" placeholder="Ej:&#10;— Tasa de show en discovery (lo veo en Calendly cada lunes)&#10;— Lag entre lead inbound y first contact (objetivo <48h)&#10;— Calidad de transcripción de discovery (¿se está pisando con el messaging del Q?)"></textarea>
            <div class="f-field-help"><strong>Métricas, procesos o señales del área Comercial que vas a estar leyendo este Q.</strong> No es trabajo de Comercial — es la lectura que vos hacés. Hacé explícito qué mirás y con qué frecuencia.</div>
          </div>

          <div class="f-field">
            <label class="f-field-label">Hallazgos del Q anterior + recomendaciones</label>
            <textarea data-field="mkt_auditoria_hallazgos" data-target="plan" class="f-field-textarea" rows="4" placeholder="Ej:&#10;Hallazgo: el discovery arrancaba siempre desde 'contenido' en vez de 'sistema'.&#10;Recomendación: reescribir guión de los primeros 5 min para llevarlo al territorio sistémico, alineado con la tesis del Q."></textarea>
            <div class="f-field-help"><strong>Lo que viste el Q pasado sobre el proceso comercial y qué ajuste proponés.</strong> Esto le llega a Francisca como contexto: saber qué viene del frente de auditoría le evita interpretarlo como crítica. Es el insumo de mejora.</div>
          </div>
        </section>

        <!-- 07 · PRODUCTO B2C -->
        <section class="f-section" id="mfs7">
          <div class="f-section-head">
            <div class="f-section-num">07</div>
            <div class="f-section-title-block">
              <div class="f-section-title">Estrategia de <em>Producto B2C.</em></div>
              <div class="f-section-sub">Como Growth Partner, dirigís la estrategia de producto del B2C. La Cáscara y Cascarita son productos vivos — acá va su rumbo del Q.</div>
            </div>
          </div>

          <div class="f-field">
            <label class="f-field-label">Dirección estratégica de La Cáscara</label>
            <textarea data-field="mkt_producto_cascara" data-target="plan" class="f-field-textarea" rows="4" placeholder="Ej: Este Q La Cáscara se enfoca en cohort de founders B2B (no abrimos a B2C). Sumamos una track de 'sistematización' en sesión 4-5. Pricing se mantiene pero se sube en Q03."></textarea>
            <div class="f-field-help"><strong>¿Hacia dónde va el programa este Q?</strong> Cambios en estructura, nuevas tracks, ajustes de pricing, decisiones de cohort. La Cáscara como producto vivo: qué cambia y por qué.</div>
          </div>

          <div class="f-field">
            <label class="f-field-label">Dirección estratégica de Cascarita</label>
            <textarea data-field="mkt_producto_cascarita" data-target="plan" class="f-field-textarea" rows="4" placeholder="Ej: Cascarita pasa a formato cohort cerrado de 30 días. Lo lanzamos en quincena 2 con waitlist. Lo posicionamos como puerta de entrada a La Cáscara."></textarea>
            <div class="f-field-help"><strong>Visión y rumbo de Cascarita este Q.</strong> Si es lanzamiento, formato y posicionamiento. Si ya está corriendo, evolución y aprendizajes.</div>
          </div>

          <div class="f-field">
            <label class="f-field-label">Decisiones de producto del Q</label>
            <textarea data-field="mkt_producto_decisiones" data-target="plan" class="f-field-textarea" rows="4" placeholder="Ej:&#10;— Cerramos el formato 1:1 — no escala&#10;— Activamos pricing tier 'Cáscara Pro' para founders que ya cursaron&#10;— Pausamos Experiences hasta Q03"></textarea>
            <div class="f-field-help"><strong>Decisiones concretas sobre el portfolio B2C que ya tomaste o se van a tomar este Q.</strong> Lo que en otras áreas serían "hitos estratégicos": acá viven como decisiones explícitas del producto.</div>
          </div>
        </section>

        <!-- 08 · ARTICULACIÓN -->
        <section class="f-section" id="mfs8">
          <div class="f-section-head">
            <div class="f-section-num">08</div>
            <div class="f-section-title-block">
              <div class="f-section-title">Articulación con <em>otras áreas.</em></div>
              <div class="f-section-sub">Qué necesita Marketing de los demás para que esta tesis se ejecute bien. La contracara de las directivas.</div>
            </div>
          </div>
          <div id="mkt-articulaciones-list">
            <div class="f-empty">Cargando articulaciones…</div>
          </div>
          <button type="button" class="f-btn-add" id="mkt-add-articulacion">+ Agregar articulación</button>
        </section>

      </div>
    `;
  },

  async populate() {
    const plan = Cascara.state.plan;
    if (!plan) return;
    // Cargar valores en textareas y date input
    document.querySelectorAll('#mkt-form-root [data-field][data-target="plan"]').forEach(el => {
      const field = el.dataset.field;
      const val = plan[field];
      if (val != null) el.value = val;
    });
  },

  bindAutoSave() {
    const root = document.getElementById('mkt-form-root');
    if (!root) return;
    root.addEventListener('input', (e) => {
      const el = e.target;
      const field = el.getAttribute('data-field');
      const target = el.getAttribute('data-target');
      if (!field || !target) return;
      const value = el.value;
      const key = `${target}:${field}`;
      Cascara.debouncedSave(key, async () => {
        await CascaraForm.ensurePlanExists();
        if (!Cascara.state.plan) return;
        if (target === 'plan') {
          await Cascara.updatePlanField(field, value);
        } else if (target === 'project') {
          const pid = el.closest('.mkt-launch')?.dataset?.projectId;
          if (pid) await Cascara.updateProjectField(pid, field, value);
        } else if (target === 'articulation') {
          const aid = el.closest('.mkt-articulacion')?.dataset?.articulationId;
          if (aid) await Cascara.updateArticulationField(aid, field, value);
        }
      });
    });

    // Nav pills scroll
    root.querySelectorAll('.fg-pill').forEach(p => {
      p.onclick = () => {
        root.querySelectorAll('.fg-pill').forEach(x => x.classList.remove('active'));
        p.classList.add('active');
        const target = document.getElementById(p.dataset.target);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
    });

    // Lanzamientos: agregar
    const addLaunchBtn = document.getElementById('mkt-add-launch');
    if (addLaunchBtn) {
      addLaunchBtn.onclick = async () => {
        await CascaraForm.ensurePlanExists();
        if (!Cascara.state.plan) return;
        const p = await Cascara.createProject(Cascara.state.plan.id);
        if (p) await this.renderLanzamientos();
      };
    }

    // Articulaciones: agregar
    const addArtBtn = document.getElementById('mkt-add-articulacion');
    if (addArtBtn) {
      addArtBtn.onclick = async () => {
        await CascaraForm.ensurePlanExists();
        if (!Cascara.state.plan) return;
        const a = await Cascara.createArticulation({ plan_id: Cascara.state.plan.id });
        if (a) await this.renderArticulaciones();
      };
    }
  },

  async renderLanzamientos() {
    const list = document.getElementById('mkt-launches-list');
    if (!list) return;
    const plan = Cascara.state.plan;
    if (!plan) {
      list.innerHTML = '<div class="f-empty">Empezá agregando un lanzamiento.</div>';
      return;
    }
    const { data: projects } = await Cascara.client.from('projects').select('*').eq('plan_id', plan.id).order('order_index');
    if (!projects || projects.length === 0) {
      list.innerHTML = '<div class="f-empty">Sin lanzamientos cargados todavía.</div>';
      return;
    }
    list.innerHTML = projects.map((p, i) => `
      <div class="mkt-launch" data-project-id="${p.id}">
        <div class="mkt-launch-head">
          <span class="mkt-launch-num">${String(i+1).padStart(2,'0')}</span>
          <input data-field="name" data-target="project" class="mkt-launch-name" value="${this.esc(p.name)}" placeholder="Nombre del lanzamiento" />
          <button type="button" class="mkt-launch-del" data-id="${p.id}">×</button>
        </div>
        <div class="mkt-launch-grid">
          <div class="f-field">
            <label class="f-field-label">Tipo de lanzamiento</label>
            <select data-field="launch_type" data-target="project" class="f-field-input">
              <option value="">Elegí tipo…</option>
              <option value="producto_nuevo" ${p.launch_type==='producto_nuevo'?'selected':''}>Producto nuevo</option>
              <option value="expansion" ${p.launch_type==='expansion'?'selected':''}>Expansión / nueva track</option>
              <option value="campana" ${p.launch_type==='campana'?'selected':''}>Campaña</option>
              <option value="activacion" ${p.launch_type==='activacion'?'selected':''}>Activación cultural</option>
              <option value="experimento" ${p.launch_type==='experimento'?'selected':''}>Experimento</option>
            </select>
          </div>
          <div class="f-field">
            <label class="f-field-label">Hipótesis</label>
            <textarea data-field="hypothesis" data-target="project" class="f-field-textarea" rows="2" placeholder="Si lanzamos X, esperamos Y porque Z.">${this.esc(p.hypothesis || '')}</textarea>
            <div class="f-field-help">Qué creemos que va a pasar y por qué. Si la hipótesis falla, sabremos qué aprendizaje sacar.</div>
          </div>
          <div class="f-field">
            <label class="f-field-label">KPI principal + objetivo</label>
            <input data-field="kpi_summary" data-target="project" class="f-field-input" value="${this.esc(p.kpi_summary || '')}" placeholder="Ej: 200 inscripciones a la waitlist" />
            <div class="f-field-help">Una sola métrica que defina éxito. Si el lanzamiento la cumple, el lanzamiento funcionó.</div>
          </div>
          <div class="f-field">
            <label class="f-field-label">Ventana estimada (texto libre)</label>
            <input data-field="time_window" data-target="project" class="f-field-input" value="${this.esc(p.time_window || '')}" placeholder="Ej: Quincena 02 — primera mitad" />
            <div class="f-field-help">Tu intención antes de la Audit Session. La quincena exacta la define el Strategy Council en el Master Timeline.</div>
          </div>
        </div>
      </div>
    `).join('');

    // Bind delete
    list.querySelectorAll('.mkt-launch-del').forEach(btn => {
      btn.onclick = async () => {
        if (!confirm('¿Eliminar este lanzamiento?')) return;
        await Cascara.client.from('projects').delete().eq('id', btn.dataset.id);
        await this.renderLanzamientos();
      };
    });
  },

  async renderArticulaciones() {
    const list = document.getElementById('mkt-articulaciones-list');
    if (!list) return;
    const plan = Cascara.state.plan;
    if (!plan) {
      list.innerHTML = '<div class="f-empty">Empezá agregando una articulación.</div>';
      return;
    }
    const { data: arts } = await Cascara.client.from('articulations').select('*, with_area:areas(name)').eq('plan_id', plan.id);
    const { data: areas } = await Cascara.client.from('areas').select('*').order('order_index');
    const otherAreas = (areas || []).filter(a => a.id !== Cascara.state.area.id);
    if (!arts || arts.length === 0) {
      list.innerHTML = '<div class="f-empty">Sin articulaciones cargadas todavía.</div>';
      return;
    }
    list.innerHTML = arts.map(a => `
      <div class="mkt-articulacion" data-articulation-id="${a.id}">
        <div class="mkt-art-head">
          <select data-field="with_area_id" data-target="articulation" class="f-field-input">
            <option value="">Elegí área…</option>
            ${otherAreas.map(o => `<option value="${o.id}" ${a.with_area_id===o.id?'selected':''}>${this.esc(o.name)}</option>`).join('')}
          </select>
          <button type="button" class="mkt-launch-del" data-id="${a.id}" data-kind="art">×</button>
        </div>
        <div class="f-field">
          <label class="f-field-label">Qué necesito de esa área</label>
          <textarea data-field="what_needs" data-target="articulation" class="f-field-textarea" rows="3" placeholder="Ej: De Operaciones necesito que el sistema de tracking de waitlist esté listo en quincena 01.">${this.esc(a.what_needs || '')}</textarea>
          <div class="f-field-help">Insumo, dato o acceso concreto que precisás de esa área para que la tesis del Q se ejecute bien.</div>
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.mkt-launch-del[data-kind="art"]').forEach(btn => {
      btn.onclick = async () => {
        if (!confirm('¿Eliminar esta articulación?')) return;
        await Cascara.client.from('articulations').delete().eq('id', btn.dataset.id);
        await this.renderArticulaciones();
      };
    });
  },

  esc(s) { return (s == null ? '' : String(s)).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); },

  injectStyles() {
    if (document.getElementById('mkt-form-style')) return;
    const s = document.createElement('style');
    s.id = 'mkt-form-style';
    s.textContent = `
      .mkt-form-root { padding: 0 64px 80px; }
      .mkt-form-root .mkt-nav { margin: 0 0 24px; }
      .mkt-form-root .mkt-content { display: flex; flex-direction: column; gap: 28px; max-width: 920px; margin: 0 auto; }
      .mkt-form-root .f-section { background: rgba(255,255,255,0.45); border: 1px solid rgba(0,0,0,0.06); border-radius: 18px; padding: 28px 32px; }
      .mkt-form-root .f-field { margin-bottom: 20px; }
      .mkt-form-root .f-field-help { font-size: 12px; color: var(--ink-muted, #52525A); line-height: 1.5; margin-top: 8px; font-style: italic; }
      .mkt-form-root .f-field-help strong { color: var(--ink); font-style: normal; font-weight: 700; }
      .mkt-form-root .f-field-textarea, .mkt-form-root .f-field-input { width: 100%; padding: 11px 14px; border: 1px solid rgba(0,0,0,0.12); border-radius: 8px; font-family: inherit; font-size: 14px; line-height: 1.5; background: #fff; color: var(--ink); resize: vertical; }
      .mkt-form-root .f-field-textarea:focus, .mkt-form-root .f-field-input:focus { outline: none; border-color: #10069F; }
      .mkt-form-root .f-field-static { padding: 11px 14px; font-size: 14px; color: var(--ink); background: rgba(0,0,0,0.03); border-radius: 8px; }
      .mkt-form-root .f-field-label { display: block; font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-muted); margin-bottom: 8px; }
      .mkt-form-root .f-empty { padding: 28px; text-align: center; color: var(--ink-muted); font-style: italic; background: rgba(0,0,0,0.03); border-radius: 10px; }
      .mkt-form-root .f-btn-add { margin-top: 16px; padding: 11px 20px; background: transparent; border: 1.5px dashed rgba(16,6,159,0.4); color: #10069F; border-radius: 8px; font-family: inherit; font-size: 13px; font-weight: 700; cursor: pointer; }
      .mkt-form-root .f-btn-add:hover { background: rgba(16,6,159,0.05); border-style: solid; }
      .mkt-form-root .f-fields-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 18px; }

      /* Lanzamientos */
      .mkt-launch { background: #fff; border: 1px solid rgba(0,0,0,0.08); border-radius: 14px; padding: 18px 22px; margin-bottom: 12px; }
      .mkt-launch-head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
      .mkt-launch-num { font-size: 11px; font-weight: 700; letter-spacing: 0.12em; color: var(--ink-muted); background: rgba(0,0,0,0.05); padding: 4px 8px; border-radius: 6px; }
      .mkt-launch-name { flex: 1; padding: 8px 12px; border: 1px solid rgba(0,0,0,0.12); border-radius: 8px; font-family: inherit; font-size: 14px; font-weight: 600; }
      .mkt-launch-name:focus { outline: none; border-color: #10069F; }
      .mkt-launch-del { background: transparent; border: 0; font-size: 22px; color: var(--ink-muted); cursor: pointer; padding: 0 8px; }
      .mkt-launch-del:hover { color: #C53030; }
      .mkt-launch-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }

      /* Articulaciones */
      .mkt-articulacion { background: #fff; border: 1px solid rgba(0,0,0,0.08); border-radius: 14px; padding: 18px 22px; margin-bottom: 12px; }
      .mkt-art-head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
      .mkt-art-head .f-field-input { flex: 1; }
    `;
    document.head.appendChild(s);
  },
};
window.CascaraFormMarketing = CascaraFormMarketing;

/* ============================================================
 * CascaraHome — refresca las 3 cards del home con data real
 * ============================================================ */
const CascaraHome = {
  async refresh() {
    if (!Cascara.state.user || !Cascara.state.quarter) return;
    this.refreshIdentity();
    await this.refreshMyPlanCard();
    await this.refreshAreasCard();
  },

  // CascaraHome es la única fuente de verdad para identidad en la home.
  // Pisamos cualquier hardcoded del markup estático con el state real.
  refreshIdentity() {
    const user = Cascara.state.user;
    if (!user) return;
    const firstName = (user.name || '').split(' ')[0] || user.name || '—';
    const initials = (user.name || '').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
    const roleLabel = user.role === 'admin' ? 'Admin' : (user.area?.name || '—');

    const greet = document.querySelector('.greet-title');
    if (greet) greet.innerHTML = `Hola ${this.escape(firstName)}.<em> Vamos a tu plan.</em>`;
    const tbName = document.querySelector('.tb-user-name');
    if (tbName) tbName.textContent = user.name;
    const tbAvatar = document.querySelector('.tb-avatar');
    if (tbAvatar) tbAvatar.textContent = initials;
    const tbRole = document.querySelector('.tb-user-role');
    if (tbRole) tbRole.textContent = roleLabel;

    // Sincronizar el currentUser legacy con el state real (por si applyUserToHome corre después)
    const dbName = (user.name || '').toLowerCase();
    const reverseMap = {
      'facundo couyet': 'facu',
      'teo pizarro': 'teo',
      'mateo pizarro': 'teo',
      'federico cristofari': 'fede',
      'juana tempesta': 'juana',
      'franco dato': 'franco',
      'francisca': 'francisca',
    };
    const k = reverseMap[dbName];
    if (k) window.currentUser = k;
  },

  escape(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  },

  async refreshMyPlanCard() {
    const area = Cascara.state.area;
    if (!area) return;

    const { data: plan } = await Cascara.client.from('plans').select('*')
      .eq('area_id', area.id).eq('quarter_id', Cascara.state.quarter.id).maybeSingle();

    const completion = await this.calculateCompletion(plan);

    const areaLbl = document.getElementById('hcs-area-lbl');
    if (areaLbl) areaLbl.textContent = `Tu plan · ${area.name}`;

    const valEl = document.querySelector('.hcard.mine .hcs-val');
    if (valEl) valEl.innerHTML = `${completion.completed} secciones <em>de 6</em> completas`;

    const pctEl = document.querySelector('.hcard.mine .hcs-pct');
    if (pctEl) pctEl.textContent = `${completion.pct}%`;

    const fill = document.querySelector('.hcard.mine .hcard-progress-fill');
    if (fill) fill.style.width = `${completion.pct}%`;

    const checks = document.querySelectorAll('.hcard.mine .hck');
    completion.sectionStates.forEach((done, i) => {
      const hck = checks[i];
      if (hck) hck.classList.toggle('done', done);
    });

    const ctaLbl = document.querySelector('.hcard.mine .hcard-cta-lbl');
    const ctaAction = document.querySelector('.hcard.mine .hcard-cta-action');
    if (!plan || completion.completed === 0) {
      if (ctaLbl) ctaLbl.textContent = 'Plan en blanco';
      if (ctaAction) ctaAction.textContent = 'Empezar mi planificación';
    } else if (completion.completed === 6) {
      if (ctaLbl) ctaLbl.textContent = 'Listo para presentar';
      if (ctaAction) ctaAction.textContent = 'Revisar mi planificación';
    } else {
      if (ctaLbl) ctaLbl.textContent = 'Continuar donde lo dejaste';
      if (ctaAction) ctaAction.textContent = 'Completar mi planificación';
    }
  },

  async calculateCompletion(plan) {
    // 6 secciones: Identidad / Contexto / Proyectos / Dependencias / Equipo / Ritmo del Q
    if (!plan) return { completed: 0, pct: 0, sectionStates: [false, false, false, false, false, false] };

    // 01 Identidad: fecha de presentación o coo_apoyo
    const s1 = !!(plan.presentation_date || plan.coo_apoyo_user_id);
    // 02 Contexto del Q: visión + aprendizajes + lo que NO vamos a hacer
    const s2 = !!(plan.vision_text || plan.learnings_text || plan.not_doing_text);
    // 03 Proyectos: al menos uno con nombre
    const { data: projects } = await Cascara.client.from('projects').select('id, name').eq('plan_id', plan.id);
    const s3 = (projects || []).some(p => p.name && p.name.trim());
    // 04 Dependencias: articulaciones o pedidos al CEO
    const { data: articulations } = await Cascara.client.from('articulations').select('id, what_delivers, what_needs').eq('plan_id', plan.id);
    const s4 = (articulations || []).some(a => (a.what_delivers && a.what_delivers.trim()) || (a.what_needs && a.what_needs.trim())) || !!plan.ceo_coo_request;
    // 05 Equipo: al menos un team member
    const { data: team } = await Cascara.client.from('team_members').select('id, name').eq('plan_id', plan.id);
    const s5 = (team || []).some(t => t.name && t.name.trim());
    // 06 Ritmo del Q: meses con milestones (fechas o notas)
    const { data: months } = await Cascara.client.from('calendar_months').select('id, milestones').eq('plan_id', plan.id);
    const s6 = (months || []).some(m => m.milestones && m.milestones.trim()) || !!plan.fortnight_notes;

    const sectionStates = [s1, s2, s3, s4, s5, s6];
    const completed = sectionStates.filter(x => x).length;
    const pct = Math.round((completed / 6) * 100);
    return { completed, pct, sectionStates };
  },

  async refreshAreasCard() {
    const myArea = Cascara.state.area;
    const list = document.querySelector('.hcard.others .areas-list');
    if (!list || !myArea) return;

    const { data: areas } = await Cascara.client.from('areas').select('*').order('order_index');
    const { data: directors } = await Cascara.client.from('users').select('*').eq('role', 'director');
    const directorByArea = new Map((directors || []).map(u => [u.area_id, u]));
    const { data: plans } = await Cascara.client.from('plans').select('*').eq('quarter_id', Cascara.state.quarter.id);
    const planByArea = new Map((plans || []).map(p => [p.area_id, p]));

    // Calcular % del plan propio (para regla de unlock a peers)
    const myPlan = planByArea.get(myArea.id);
    let myCompletion = { pct: 0, completed: 0 };
    if (myPlan) myCompletion = await this.calculateCompletion(myPlan);
    const PEER_UNLOCK_THRESHOLD = 70;
    const peersUnlocked = myCompletion.pct >= PEER_UNLOCK_THRESHOLD || Cascara.isAdmin();

    list.innerHTML = '';
    (areas || []).forEach((a, i) => {
      const isMine = a.id === myArea.id;
      const director = directorByArea.get(a.id);
      const plan = planByArea.get(a.id);
      const num = String(i + 1).padStart(2, '0');

      let statusText, statusClass, actionText, rowClass = '';
      let clickHandler = null;

      if (isMine) {
        statusText = myPlan ? `${myCompletion.pct}% cargado` : 'Sin iniciar';
        statusClass = 'pending';
        actionText = `Tu plan <span class="arrow">→</span>`;
        rowClass = 'self';
        clickHandler = (e) => { e.stopPropagation(); window.goTo('formulario'); };
      } else if (plan && ['approved', 'in_progress', 'closed'].includes(plan.status)) {
        statusText = 'Presentado';
        statusClass = 'done';
        actionText = `Ver plan <span class="arrow">→</span>`;
        clickHandler = (e) => { e.stopPropagation(); window.openPreso(a.slug); };
      } else if (plan && peersUnlocked) {
        // El plan ajeno está en borrador, pero el director propio ya pasó el 70% → puede asomarse al borrador
        statusText = 'Borrador visible';
        statusClass = 'pending';
        actionText = `Ver borrador <span class="arrow">→</span>`;
        clickHandler = (e) => { e.stopPropagation(); window.openPreso(a.slug); };
      } else if (plan) {
        statusText = 'En proceso';
        statusClass = 'pending';
        actionText = 'Llegá al 70%';
        rowClass = 'locked';
      } else if (peersUnlocked) {
        // No hay plan del peer todavía, pero el director propio cumplió: marcar como "Sin iniciar"
        statusText = 'Sin iniciar';
        statusClass = 'locked';
        actionText = '—';
        rowClass = 'locked';
      } else {
        statusText = 'Sin iniciar';
        statusClass = 'locked';
        actionText = 'Llegá al 70%';
        rowClass = 'locked';
      }

      const directorName = director?.name || (a.slug === 'capital' ? 'Facundo Couyet · CEO' : '—');

      const row = document.createElement('div');
      row.className = `area-row ${rowClass}`.trim();
      row.innerHTML = `
        <span class="area-num">${num}</span>
        <div class="area-info">
          <span class="area-name">${a.name}</span>
          <span class="area-director">${directorName}</span>
        </div>
        <span class="area-status ${statusClass}">${statusText}</span>
        <span class="area-action">${actionText}</span>
      `;
      if (clickHandler) row.onclick = clickHandler;
      list.appendChild(row);
    });
  },

  // Rápido: cuántas secciones tienen contenido (sin queries adicionales — sólo plan)
  quickCount(plan) {
    let n = 0;
    if (plan.presentation_date || plan.coo_apoyo_user_id) n++;
    if (plan.vision_text) n++;
    // Para las otras secciones necesitaríamos queries, pero refreshMyPlanCard ya hace eso preciso
    return n;
  },
};
window.CascaraHome = CascaraHome;

/* ============================================================
 * LOGIN OVERRIDE — vincula el flujo de login al user real en DB
 * Lo bindeamos lo antes posible para evitar races
 * ============================================================ */
const USER_KEY_TO_DB_SLUG = {
  facu: 'facundo couyet',
  teo: 'teo pizarro',
  fede: 'federico cristofari',
  juana: 'juana tempesta',
  franco: 'franco dato',
  francisca: 'francisca',
};

function bindLoginOverride() {
  if (!window.loginAs || window.loginAs._cascaraBound) return false;
  const originalLoginAs = window.loginAs;

  window.loginAs = async function(userKey) {
    // CRÍTICO: esperar a que Cascara esté listo ANTES de cualquier cosa
    if (!Cascara.state.ready) {
      await new Promise(res => document.addEventListener('cascara:ready', res, { once: true }));
    }
    // Limpiar cualquier sesión previa en memoria por las dudas
    Cascara.state.plan = null;

    const dbName = USER_KEY_TO_DB_SLUG[userKey];
    let dbUser = null;
    if (dbName) {
      const users = await Cascara.listUsers();
      dbUser = users.find(u => u.name.toLowerCase() === dbName);
    }
    if (dbUser) {
      await Cascara.login(dbUser.id);
    } else {
      // Si no encontró un match, no permitimos seguir — evita confusión de identidad
      console.error('[Cascara] No se encontró usuario en DB para key:', userKey);
      alert('No se pudo identificar tu usuario en el sistema. Recargá la página.');
      return;
    }
    return originalLoginAs(userKey);
  };
  window.loginAs._cascaraBound = true;
  return true;
}

/* ============================================================
 * BOOTSTRAP
 * ============================================================ */
document.addEventListener('DOMContentLoaded', async () => {
  // PRIMERO: intentar bindear loginAs lo antes posible (sin esperar init)
  bindLoginOverride();
  // Reintentos por si loginAs todavía no se definió
  setTimeout(bindLoginOverride, 10);
  setTimeout(bindLoginOverride, 50);
  setTimeout(bindLoginOverride, 200);

  await Cascara.init();

  // Reintento final post-init
  bindLoginOverride();

  // SYNC AGRESIVO: si el user ya clickeó alguien ANTES de que mi wrapper bindee,
  // currentUser global está seteado pero Cascara state no. Sincronizamos ya.
  async function aggressiveSyncToUI() {
    if (!Cascara.state.ready) return;
    const uiKey = window.currentUser;
    if (!uiKey) return;
    const expectedName = USER_KEY_TO_DB_SLUG[uiKey];
    if (!expectedName) return;
    const currentName = Cascara.state.user?.name?.toLowerCase();
    if (currentName === expectedName) return; // ya están sincronizados
    // Mismatch detectado: forzar login en Cascara
    const users = await Cascara.listUsers();
    const dbUser = users.find(u => u.name.toLowerCase() === expectedName);
    if (dbUser) {
      console.warn('[Cascara] Aggressive sync triggered:', { uiKey, expectedName, was: currentName });
      await Cascara.login(dbUser.id);
      if (typeof injectNavLinks === 'function') injectNavLinks();
      if (window.CascaraHome) CascaraHome.refresh();
    }
  }
  window._cascaraAggressiveSync = aggressiveSyncToUI;

  // Disparar el sync agresivo en varios momentos críticos
  document.addEventListener('cascara:ready', () => {
    aggressiveSyncToUI();
    setTimeout(aggressiveSyncToUI, 300);
    setTimeout(aggressiveSyncToUI, 1000);
  });
  if (Cascara.state.ready) {
    aggressiveSyncToUI();
    setTimeout(aggressiveSyncToUI, 300);
    setTimeout(aggressiveSyncToUI, 1000);
  }

  // Sync extra: cuando aplican el user al home (UI), verificar que Cascara state coincida
  const tryWrapApplyUserToHome = () => {
    if (typeof window.applyUserToHome !== 'function' || window.applyUserToHome._cascaraWrapped) {
      return;
    }
    const original = window.applyUserToHome;
    window.applyUserToHome = async function() {
      const result = original.apply(this, arguments);
      // Si la UI dice una cosa pero Cascara state dice otra, re-sincronizar
      const uiKey = window.currentUser;
      if (uiKey && USER_KEY_TO_DB_SLUG[uiKey]) {
        const expectedName = USER_KEY_TO_DB_SLUG[uiKey];
        const currentName = Cascara.state.user?.name?.toLowerCase();
        if (currentName !== expectedName) {
          console.warn('[Cascara] Mismatch UI vs state, re-sincronizando login:', { uiKey, currentName, expectedName });
          if (Cascara.state.ready) {
            const users = await Cascara.listUsers();
            const dbUser = users.find(u => u.name.toLowerCase() === expectedName);
            if (dbUser) await Cascara.login(dbUser.id);
            // Re-renderizar lo que dependa del rol
            if (typeof injectNavLinks === 'function') injectNavLinks();
            if (Cascara.state.user && CascaraHome) CascaraHome.refresh();
          }
        }
      }
      return result;
    };
    window.applyUserToHome._cascaraWrapped = true;
  };
  setTimeout(tryWrapApplyUserToHome, 100);
  setTimeout(tryWrapApplyUserToHome, 500);

  // Hookear navegación entre vistas
  const tryHookFormEntry = () => {
    if (!window.goTo) {
      setTimeout(tryHookFormEntry, 200);
      return;
    }
    const originalGoTo = window.goTo;
    if (originalGoTo._cascaraHooked) return;
    window.goTo = function(viewName) {
      // SYNC AGRESIVO: cada navegación dispara verificación de identidad
      if (viewName !== 'login' && window._cascaraAggressiveSync) {
        window._cascaraAggressiveSync();
      }

      // Persistir vista actual (excepto login y official-preso que necesita state extra)
      if (viewName && viewName !== 'login' && viewName !== 'official-preso') {
        try { localStorage.setItem('cascara_view', viewName); } catch (_) {}
      }

      // Al volver al home, resetear el contexto del área al área del usuario
      if (viewName === 'home' && Cascara.state.user) {
        Cascara.state.area = Cascara.state.user.area;
        Cascara.state.plan = null;
      }
      // IMPORTANTE: crear la view ANTES de que goTo original busque el elemento
      if (viewName === 'admin-dashboard') CascaraAdmin.ensureView();
      if (viewName === 'check-ins') CascaraCheckIns.ensureView();
      if (viewName === 'official-preso') CascaraOfficialPreso.ensureView();
      if (viewName === 'audit-session') CascaraAudit.ensureView();

      // Ocultar banner de ejemplo al cambiar de vista
      if (viewName !== 'preso-viewer') CascaraPresentations.hideBanner();

      originalGoTo(viewName);

      // Forzar .active por si la view se creó recién (originalGoTo ya corrió)
      const target = document.getElementById('view-' + viewName);
      if (target) target.classList.add('active');

      if (viewName === 'formulario') CascaraForm.enter();
      if (viewName === 'admin-dashboard') CascaraAdmin.enter();
      if (viewName === 'check-ins') CascaraCheckIns.enter();
      if (viewName === 'audit-session') CascaraAudit.enter();
      if (viewName === 'home') {
        CascaraPresentations.refreshMarks();
        CascaraHome.refresh();
      }
      if (viewName === 'presentaciones') CascaraPresentations.refreshMarks();
    };
    window.goTo._cascaraHooked = true;
  };
  setTimeout(tryHookFormEntry, 100);

  // Inyectar navegación según rol después del login
  document.addEventListener('cascara:user-changed', () => injectNavLinks());
  if (Cascara.state.user) setTimeout(injectNavLinks, 300);

  // Las 7 presentaciones son las descripciones de las áreas (no auto-generadas).
  // No interceptamos openPreso ni mostramos banner.

  // Refrescar marcas Ejemplo/Oficial + cards del home cuando esté lista
  setTimeout(() => {
    CascaraPresentations.refreshMarks();
    if (Cascara.state.user) CascaraHome.refresh();
  }, 500);

  // Restaurar la última vista si el usuario ya estaba logueado
  // Lo hacemos lo antes posible para que no haya flash del login screen
  const doRestore = () => {
    if (!Cascara.state.user || !window.goTo) {
      // No hay sesión válida: liberar la clase restoring para mostrar el login normalmente
      document.body.classList.remove('cascara-restoring');
      return;
    }
    // Sincronizar identidad ANTES de navegar — pisa cualquier hardcoded del markup
    if (window.CascaraHome) CascaraHome.refreshIdentity();
    const saved = localStorage.getItem('cascara_view');
    const target = (saved && saved !== 'login') ? saved : 'home';
    window.goTo(target);
    // Liberar después de navegar — el login queda oculto y home visible
    requestAnimationFrame(() => document.body.classList.remove('cascara-restoring'));
  };
  if (Cascara.state.ready) doRestore();
  else document.addEventListener('cascara:ready', doRestore, { once: true });

  // Keyboard nav para official preso
  document.addEventListener('keydown', e => {
    const v = document.getElementById('view-official-preso');
    if (!v || !v.classList.contains('active')) return;
    if (e.key === 'ArrowRight' || e.key === ' ') CascaraOfficialPreso.show(CascaraOfficialPreso.slideIdx + 1);
    if (e.key === 'ArrowLeft') CascaraOfficialPreso.show(CascaraOfficialPreso.slideIdx - 1);
  });
});

// Helper: clickear la pill del usuario debe LIMPIAR la sesión cacheada y dejar
// el login estático para elegir. Evita el bug de "loguearse" como el mismo user de antes.
window.cascaraGoToLogin = function() {
  try {
    localStorage.removeItem('cascara_user_id');
    localStorage.removeItem('cascara_view');
  } catch (_) {}
  if (window.Cascara) Cascara.logout?.();
  // Resetear currentUser legacy también
  if (typeof window.currentUser !== 'undefined') window.currentUser = null;
  // Resetear el sub-state del login: mostrar selector, no la pantalla "Hola X"
  if (typeof window.showLoginState === 'function') window.showLoginState('select');
  // Forzar navegación a login
  document.body.classList.remove('cascara-restoring');
  if (window.goTo) window.goTo('login');
};

// Lock global para evitar races: si una corrida está en curso, las demás esperan
let _navInjectInFlight = null;
async function injectNavLinks() {
  if (_navInjectInFlight) return _navInjectInFlight;
  _navInjectInFlight = (async () => {
    try {
      // CRÍTICO: limpiar TODOS los containers que puedan tener nav-links viejos
      document.querySelectorAll('.cascara-nav-link').forEach(el => el.remove());

      const toolbar = document.querySelector('.tb-actions') || document.querySelector('.toolbar');
      let container = toolbar;
      if (!container) {
        const sample = document.querySelector('.tb-link');
        if (!sample) return;
        container = sample.parentElement;
      }

      // Cachear isStrategyCouncil para no hacer await entre cleanups y adds
      const isSC = await Cascara.isStrategyCouncil();
      const isAdmin = Cascara.isAdmin();

      // Volver a limpiar después del await por si entre medio otra cosa metió botones
      document.querySelectorAll('.cascara-nav-link').forEach(el => el.remove());

      // Audit Session (Strategy Council o Admin)
      if (isSC || isAdmin) {
        const auditBtn = document.createElement('button');
        auditBtn.className = 'tb-link cascara-nav-link';
        auditBtn.innerHTML = 'Audit Session <span class="arrow">→</span>';
        auditBtn.onclick = () => window.goTo('audit-session');
        container.insertBefore(auditBtn, container.firstChild);
      }

      if (isAdmin) {
        const adminBtn = document.createElement('button');
        adminBtn.className = 'tb-link cascara-nav-link';
        adminBtn.innerHTML = 'Dashboard global <span class="arrow">→</span>';
        adminBtn.onclick = () => window.goTo('admin-dashboard');
        container.insertBefore(adminBtn, container.firstChild);
      }

      const ciBtn = document.createElement('button');
      ciBtn.className = 'tb-link cascara-nav-link';
      ciBtn.innerHTML = 'Mis check-ins <span class="arrow">→</span>';
      ciBtn.onclick = () => window.goTo('check-ins');
      container.insertBefore(ciBtn, container.firstChild);
    } finally {
      _navInjectInFlight = null;
    }
  })();
  return _navInjectInFlight;
}

// Compat: addNavLinksTo era el nombre viejo
const addNavLinksTo = injectNavLinks;
