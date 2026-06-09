const GRADES = ["七年级", "八年级", "九年级", "高一", "高二", "高三"];
const COURSE_TYPES = {
  oneToOne: "一对一",
  classCourse: "班课"
};
const TYPE_GROUPS = [
  ["oneToOne", "一对一"],
  ["classCourse", "班课"]
];
const STATUS_LABELS = {
  present: "到课",
  leave: "请假",
  absent: "缺席"
};
const STATUS_ORDER = ["present", "leave", "absent"];
const DEFAULT_STANDARDS = {
  "七年级": { oneToOne: 120, oneToTwo: 140 },
  "八年级": { oneToOne: 130, oneToTwo: 150 },
  "九年级": { oneToOne: 140, oneToTwo: 160 },
  "高一": { oneToOne: 160, oneToTwo: 200 },
  "高二": { oneToOne: 180, oneToTwo: 220 },
  "高三": { oneToOne: 200, oneToTwo: 240 }
};
const STORE_KEY = "teacher-payroll-v1";
const MIGRATION_KEY = "teacher-payroll-cloud-migrated-v1";

let activeTemplate = null;
let lessonAttendance = [];
let editingClassStudents = [];
let supabaseClient = null;
let currentUser = null;
let isCloudReady = false;
let isBootstrapping = true;

const $ = (id) => document.getElementById(id);
const clone = (value) => JSON.parse(JSON.stringify(value));
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const today = () => new Date().toISOString().slice(0, 10);
const currentMonth = () => today().slice(0, 7);
const money = (value) => `¥${Number(value || 0).toLocaleString("zh-CN")}`;
const numberOrNull = (value) => value === "" || value === null || Number.isNaN(Number(value)) ? null : Number(value);
const normalizeCourseType = (type) => type === "oneToTwo" || type === "smallClass" || type === "multi" ? "classCourse" : type;
const normalizeTag = (value) => String(value || "").trim();
const h = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#039;"
}[char]));

let state = loadState();

function loadState() {
  const fallback = {
    students: [],
    classes: [],
    courseTemplates: [],
    records: [],
    settings: {
      standards: clone(DEFAULT_STANDARDS),
      defaultSmallExtra: 10
    }
  };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    const merged = {
      ...fallback,
      ...saved,
      courseTemplates: saved?.courseTemplates || [],
      settings: {
        ...fallback.settings,
        ...(saved?.settings || {}),
        standards: { ...fallback.settings.standards, ...(saved?.settings?.standards || {}) }
      }
    };
    return migrateState(merged);
  } catch {
    return fallback;
  }
}

function migrateState(data) {
  const students = (data.students || []).map((student) => ({
    id: student.id || uid(),
    name: student.name || "",
    grade: student.grade || GRADES[0],
    institutionTag: normalizeTag(student.institutionTag || student.tag || student.sourceTag),
    specialOne: student.specialOne ?? null,
    note: student.note || ""
  }));
  const oldStudents = data.students || [];
  const classes = (data.classes || []).map((classItem) => {
    const existingMembers = Array.isArray(classItem.students) ? classItem.students : [];
    const migratedMembers = existingMembers.length ? existingMembers : oldStudents
      .filter((student) => student.classId === classItem.id || (classItem.memberIds || []).includes(student.id))
      .map((student) => ({ id: student.id || uid(), name: student.name || "", status: "active", note: "" }));
    return {
      id: classItem.id || uid(),
      name: classItem.name || "",
      grade: classItem.grade || GRADES[0],
      institutionTag: normalizeTag(classItem.institutionTag || classItem.tag || classItem.sourceTag),
      students: migratedMembers.map((member) => ({
        id: member.id || uid(),
        name: member.name || "",
        status: member.status || "active",
        note: member.note || ""
      })),
      smallBasePrice: classItem.smallBasePrice ?? null,
      extraPerStudent: classItem.extraPerStudent ?? 10,
      note: classItem.note || ""
    };
  });
  const courseTemplates = (data.courseTemplates || []).map((template) => {
    const courseType = normalizeCourseType(template.courseType);
    return {
      ...template,
      courseType,
      sourceType: courseType === "classCourse" ? "class" : "personal",
      fixedMode: template.fixedMode || "auto",
      fixedPrice: template.fixedPrice ?? null
    };
  });
  const records = (data.records || []).map((record) => ({
    ...record,
    courseType: normalizeCourseType(record.courseType),
    institutionTag: normalizeTag(record.institutionTag || record.tag || record.sourceTag)
  }));
  return { ...data, students, classes, courseTemplates, records };
}

function saveState() {
  renderAll();
  if (isBootstrapping) return;
  if (currentUser && isCloudReady) {
    syncCloudState();
  } else {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  }
}

function init() {
  ["studentGrade", "studentGradeFilter", "classGrade", "templateGrade"].forEach((id) => fillGradeSelect($(id), id === "studentGradeFilter"));
  $("lessonDate").value = today();
  $("filterDate").value = "";
  $("filterMonth").value = currentMonth();
  $("todayLine").textContent = `${today()}，上完课，点模板，记工资。`;

  document.querySelectorAll(".tab").forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.tab)));
  $("lessonForm").addEventListener("submit", saveLesson);
  $("resetLessonBtn").addEventListener("click", resetLessonForm);
  $("manualAmount").addEventListener("input", updateLessonCalculation);
  $("trialStudentsInput").addEventListener("input", syncTrialStudents);
  $("allPresentBtn").addEventListener("click", () => {
    lessonAttendance = lessonAttendance.map((item) => ({ ...item, status: "present" }));
    renderLessonPickers();
    updateLessonCalculation();
  });
  document.querySelectorAll(".quick-notes button").forEach((button) => {
    button.addEventListener("click", () => appendNote(button.dataset.note));
  });

  $("templateForm").addEventListener("submit", saveTemplate);
  $("resetTemplateBtn").addEventListener("click", resetTemplateForm);
  $("templateName").addEventListener("input", updateTemplateNameManualState);
  $("templateClass").addEventListener("input", () => syncTemplateNameWithSelection());
  ["templateType", "templateGrade", "templateBillingMode"].forEach((id) => $(id).addEventListener("input", renderTemplateFormPickers));

  $("studentForm").addEventListener("submit", saveStudent);
  $("resetStudentBtn").addEventListener("click", resetStudentForm);
  $("studentSearch").addEventListener("input", renderStudents);
  $("studentGradeFilter").addEventListener("input", renderStudents);

  $("classForm").addEventListener("submit", saveClass);
  $("resetClassBtn").addEventListener("click", resetClassForm);
  $("addClassStudentsBtn").addEventListener("click", addBulkClassStudents);

  $("filterDate").addEventListener("input", renderStats);
  $("filterMonth").addEventListener("input", () => {
    $("filterDate").value = "";
    renderStats();
  });
  $("filterTag").addEventListener("input", renderStats);
  $("exportCsvBtn").addEventListener("click", exportCurrentMonthCsv);
  $("exportJsonBtn").addEventListener("click", exportJsonBackup);
  $("importJsonBtn").addEventListener("click", () => $("importJsonFile").click());
  $("importJsonFile").addEventListener("change", importJsonBackup);

  $("saveStandardsBtn").addEventListener("click", saveStandards);
  $("resetStandardsBtn").addEventListener("click", resetStandards);
  $("loginBtn").addEventListener("click", loginUser);
  $("registerBtn").addEventListener("click", registerUser);
  $("logoutBtn").addEventListener("click", logoutUser);

  resetClassForm(false);
  initSupabase();
}

function fillGradeSelect(select, includeAll = false) {
  select.innerHTML = (includeAll ? [`<option value="">全部年级</option>`] : [])
    .concat(GRADES.map((grade) => `<option value="${grade}">${grade}</option>`))
    .join("");
}

function switchTab(tabId) {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.tab === tabId));
  document.querySelectorAll(".page").forEach((page) => page.classList.toggle("is-active", page.id === tabId));
}

async function initSupabase() {
  const config = window.SUPABASE_CONFIG || {};
  if (!window.supabase) {
    showAuthOnly("Supabase 登录库没有加载成功，请确认网络可以访问 jsdelivr CDN。");
    setSyncStatus("未连接");
    isBootstrapping = false;
    return;
  }
  isCloudReady = Boolean(config.url && config.anonKey && !config.url.includes("YOUR_SUPABASE") && !config.anonKey.includes("YOUR_SUPABASE"));
  if (!isCloudReady) {
    showAuthOnly("请先在 supabase-config.js 填写 Supabase URL 和 anon public key。");
    setSyncStatus("未配置");
    isBootstrapping = false;
    return;
  }
  supabaseClient = window.supabase.createClient(config.url, config.anonKey);
  const { data } = await supabaseClient.auth.getSession();
  currentUser = data.session?.user || null;
  supabaseClient.auth.onAuthStateChange(async (_event, session) => {
    currentUser = session?.user || null;
    if (currentUser) await enterApp();
    else showAuthOnly();
  });
  if (currentUser) await enterApp();
  else showAuthOnly();
  isBootstrapping = false;
}

function showAuthOnly(message = "") {
  $("authPage").classList.remove("hidden");
  document.querySelector(".app-shell").classList.add("hidden");
  $("authMessage").textContent = message;
  $("accountEmail").textContent = "未登录";
}

function showApp() {
  $("authPage").classList.add("hidden");
  document.querySelector(".app-shell").classList.remove("hidden");
  $("accountEmail").textContent = currentUser?.email || "";
}

async function enterApp() {
  showApp();
  setSyncStatus("加载中");
  try {
    state = await loadCloudState();
    await maybeMigrateLocalData();
    renderAll();
    updateLessonCalculation();
    setSyncStatus("已同步");
  } catch (error) {
    setSyncStatus("同步失败");
    $("authMessage").textContent = error.message || "云端数据加载失败。";
  }
}

async function loginUser() {
  if (!supabaseClient) return $("authMessage").textContent = "请先配置 Supabase。";
  const email = $("authEmail").value.trim();
  const password = $("authPassword").value;
  if (!email || !password) return $("authMessage").textContent = "请填写邮箱和密码。";
  $("authMessage").textContent = "登录中...";
  const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
  $("authMessage").textContent = error ? error.message : "";
}

async function registerUser() {
  if (!supabaseClient) return $("authMessage").textContent = "请先配置 Supabase。";
  const email = $("authEmail").value.trim();
  const password = $("authPassword").value;
  if (!email || !password) return $("authMessage").textContent = "请填写邮箱和密码。";
  $("authMessage").textContent = "注册中...";
  const { error } = await supabaseClient.auth.signUp({ email, password });
  $("authMessage").textContent = error ? error.message : "注册成功。如果 Supabase 开启了邮箱验证，请先去邮箱确认。";
}

async function logoutUser() {
  await supabaseClient.auth.signOut();
  currentUser = null;
  state = loadState();
  activeTemplate = null;
  lessonAttendance = [];
  showAuthOnly();
}

function setSyncStatus(text) {
  $("syncStatus").textContent = text;
}

async function maybeMigrateLocalData() {
  if (localStorage.getItem(MIGRATION_KEY)) return;
  const localRaw = localStorage.getItem(STORE_KEY);
  if (!localRaw) return;
  let localState;
  try {
    localState = migrateState(JSON.parse(localRaw));
  } catch {
    localStorage.setItem(MIGRATION_KEY, "invalid-local-data");
    return;
  }
  const hasLocalData = localState.students.length || localState.classes.length || localState.courseTemplates.length || localState.records.length;
  const hasCloudData = state.students.length || state.classes.length || state.courseTemplates.length || state.records.length;
  if (!hasLocalData || hasCloudData) {
    localStorage.setItem(MIGRATION_KEY, "ignored-or-not-needed");
    return;
  }
  if (confirm("检测到本地旧数据，是否迁移到云端？")) {
    state = localState;
    await syncCloudState();
    localStorage.setItem(MIGRATION_KEY, "migrated");
    alert("本地旧数据已迁移到云端。");
  } else {
    localStorage.setItem(MIGRATION_KEY, "ignored");
  }
}

function renderAll() {
  renderLessonTemplates();
  renderLessonPickers();
  renderTemplateFormPickers();
  renderTemplateList();
  renderStudents();
  renderClasses();
  renderClassStudentList();
  renderTagFilter();
  renderStats();
  renderSettings();
  updateHeaderTotal();
}

async function loadCloudState() {
  const [studentsRes, classesRes, templatesRes, settingsRes, recordsRes] = await Promise.all([
    supabaseClient.from("one_on_one_students").select("*").order("created_at"),
    supabaseClient.from("classes").select("*").order("created_at"),
    supabaseClient.from("course_templates").select("*").order("sort_order"),
    supabaseClient.from("salary_settings").select("*").limit(1),
    supabaseClient.from("lesson_records").select("*").order("date", { ascending: false })
  ]);
  const error = studentsRes.error || classesRes.error || templatesRes.error || settingsRes.error || recordsRes.error;
  if (error) throw error;
  const settingsRow = settingsRes.data?.[0];
  return migrateState({
    students: (studentsRes.data || []).map(fromStudentRow),
    classes: (classesRes.data || []).map(fromClassRow),
    courseTemplates: (templatesRes.data || []).map(fromTemplateRow),
    records: (recordsRes.data || []).map(fromRecordRow),
    settings: settingsRow ? {
      standards: settingsRow.standards,
      defaultSmallExtra: settingsRow.default_small_extra
    } : {
      standards: clone(DEFAULT_STANDARDS),
      defaultSmallExtra: 10
    }
  });
}

async function syncCloudState() {
  if (!currentUser || !isCloudReady) return;
  setSyncStatus("保存中");
  try {
    const userId = currentUser.id;
    await ensureProfile(userId);
    await deleteUserRows();
    const now = new Date().toISOString();
    await insertRows("one_on_one_students", state.students.map((student) => toStudentRow(student, userId, now)));
    await insertRows("classes", state.classes.map((classItem) => toClassRow(classItem, userId, now)));
    await insertRows("course_templates", state.courseTemplates.map((template) => toTemplateRow(template, userId, now)));
    await insertRows("lesson_records", state.records.map((record) => toRecordRow(record, userId, now)));
    await insertRows("salary_settings", [{
      id: "default",
      user_id: userId,
      standards: state.settings.standards,
      default_small_extra: state.settings.defaultSmallExtra,
      created_at: now,
      updated_at: now
    }]);
    setSyncStatus("已同步");
  } catch (error) {
    console.error(error);
    setSyncStatus("同步失败");
  }
}

async function ensureProfile(userId) {
  await supabaseClient.from("profiles").upsert({
    user_id: userId,
    email: currentUser.email,
    updated_at: new Date().toISOString()
  }, { onConflict: "user_id" });
}

async function deleteUserRows() {
  const userId = currentUser.id;
  await Promise.all([
    supabaseClient.from("one_on_one_students").delete().eq("user_id", userId),
    supabaseClient.from("classes").delete().eq("user_id", userId),
    supabaseClient.from("course_templates").delete().eq("user_id", userId),
    supabaseClient.from("lesson_records").delete().eq("user_id", userId),
    supabaseClient.from("salary_settings").delete().eq("user_id", userId)
  ]);
}

async function insertRows(table, rows) {
  if (!rows.length) return;
  const { error } = await supabaseClient.from(table).insert(rows);
  if (error) throw error;
}

function toStudentRow(student, userId, now) {
  return {
    id: student.id,
    user_id: userId,
    name: student.name,
    grade: student.grade,
    institution_tag: student.institutionTag || "",
    special_one: student.specialOne,
    note: student.note || "",
    created_at: now,
    updated_at: now
  };
}

function fromStudentRow(row) {
  return {
    id: row.id,
    name: row.name,
    grade: row.grade,
    institutionTag: row.institution_tag || "",
    specialOne: row.special_one ?? null,
    note: row.note || ""
  };
}

function toClassRow(classItem, userId, now) {
  return {
    id: classItem.id,
    user_id: userId,
    name: classItem.name,
    grade: classItem.grade,
    institution_tag: classItem.institutionTag || "",
    students: classItem.students || [],
    fixed_price: classItem.smallBasePrice,
    extra_per_student: classItem.extraPerStudent ?? 10,
    note: classItem.note || "",
    created_at: now,
    updated_at: now
  };
}

function fromClassRow(row) {
  return {
    id: row.id,
    name: row.name,
    grade: row.grade,
    institutionTag: row.institution_tag || "",
    students: row.students || [],
    smallBasePrice: row.fixed_price ?? null,
    extraPerStudent: row.extra_per_student ?? 10,
    note: row.note || ""
  };
}

function toTemplateRow(template, userId, now) {
  return {
    id: template.id,
    user_id: userId,
    name: template.name,
    course_type: template.courseType,
    grade: template.grade,
    student_ids: template.studentIds || [],
    class_id: template.classId || null,
    class_name: template.className || "",
    fixed_mode: template.fixedMode || "auto",
    fixed_price: template.fixedPrice,
    enabled: template.enabled !== false,
    sort_order: template.sortOrder ?? 100,
    note: template.note || "",
    last_used_at: template.lastUsedAt || null,
    created_at: now,
    updated_at: now
  };
}

function fromTemplateRow(row) {
  return {
    id: row.id,
    name: row.name,
    courseType: row.course_type,
    grade: row.grade,
    studentIds: row.student_ids || [],
    classId: row.class_id || "",
    className: row.class_name || "",
    fixedMode: row.fixed_mode || "auto",
    fixedPrice: row.fixed_price ?? null,
    enabled: row.enabled !== false,
    sortOrder: row.sort_order ?? 100,
    note: row.note || "",
    lastUsedAt: row.last_used_at || ""
  };
}

function toRecordRow(record, userId, now) {
  return {
    id: record.id,
    user_id: userId,
    date: record.date,
    template_id: record.templateId || null,
    course_name: record.courseName || "",
    course_type: record.courseType,
    grade: record.grade,
    institution_tag: record.institutionTag || "",
    student_name: record.studentName || "",
    class_id: record.classId || null,
    class_name: record.className || "",
    attendance: record.attendance || [],
    attendance_count: record.attendanceCount || 0,
    leave_count: record.leaveCount || 0,
    absent_count: record.absentCount || 0,
    amount: record.amount || 0,
    price_source: record.priceSource || "",
    manual_amount: record.manualAmount,
    note: record.note || "",
    confirmed: Boolean(record.confirmed),
    created_at: now,
    updated_at: now
  };
}

function fromRecordRow(row) {
  return {
    id: row.id,
    date: row.date,
    templateId: row.template_id || "",
    courseName: row.course_name || "",
    courseType: row.course_type,
    grade: row.grade,
    institutionTag: row.institution_tag || "",
    studentName: row.student_name || "",
    classId: row.class_id || "",
    className: row.class_name || "",
    attendance: row.attendance || [],
    attendanceCount: row.attendance_count || 0,
    leaveCount: row.leave_count || 0,
    absentCount: row.absent_count || 0,
    amount: row.amount || 0,
    priceSource: row.price_source || "",
    manualAmount: row.manual_amount ?? null,
    note: row.note || "",
    confirmed: Boolean(row.confirmed)
  };
}

function appendNote(text) {
  const current = $("lessonNote").value.trim();
  $("lessonNote").value = current ? `${current}；${text}` : text;
}

function sortedTemplates(includeDisabled = false) {
  return state.courseTemplates
    .filter((template) => includeDisabled || template.enabled !== false)
    .sort((a, b) => ((b.lastUsedAt || "").localeCompare(a.lastUsedAt || "")) || a.name.localeCompare(b.name, "zh-CN"));
}

function renderLessonTemplates() {
  const templates = sortedTemplates(false);
  if (!templates.length) {
    $("lessonTemplates").innerHTML = `<div class="empty">还没有启用的课程模板，请先到“课程模板”页新增。</div>`;
    return;
  }
  $("lessonTemplates").innerHTML = TYPE_GROUPS.map(([type, label]) => {
    const group = templates.filter((template) => template.courseType === type);
    if (!group.length) return "";
    return `
      <div class="template-group">
        <h3>${label}</h3>
        <div class="template-grid">
          ${group.map((template) => lessonTemplateCard(template)).join("")}
        </div>
      </div>
    `;
  }).join("");
}

function lessonTemplateCard(template) {
  const classItem = getClass(template.classId);
  const students = (template.studentIds || []).map((id) => getStudent(id)).filter(Boolean);
  const className = classItem?.name || template.className || "";
  const studentNames = students.map((student) => student.name).join("、") || (template.studentIds || []).map(() => "已删除学生").join("、");
  const tag = template.courseType === "classCourse" ? classItem?.institutionTag : students[0]?.institutionTag;
  const subtitle = template.courseType === "classCourse" ? className : studentNames;
  return `
    <button type="button" class="template-card ${activeTemplate?.id === template.id ? "is-selected" : ""}" onclick="selectLessonTemplate('${template.id}')">
      <strong>${h(template.name)}</strong>
      <span>${h(COURSE_TYPES[template.courseType])}｜${h(template.grade)}</span>
      <small>${h([subtitle || "未关联", tag].filter(Boolean).join("｜"))}</small>
    </button>
  `;
}

function selectLessonTemplate(id) {
  const template = state.courseTemplates.find((item) => item.id === id);
  if (!template) return;
  activeTemplate = template;
  $("selectedTemplateId").value = id;
  $("trialStudentsInput").value = "";
  lessonAttendance = buildAttendanceFromTemplate(template);
  renderLessonTemplates();
  renderLessonPickers();
  updateLessonCalculation();
}

function buildAttendanceFromTemplate(template) {
  if (template.courseType === "classCourse") {
    const classItem = getClass(template.classId);
    return (classItem?.students || [])
      .filter((student) => student.status !== "inactive")
      .map((student) => ({ studentId: student.id, name: student.name, status: "present" }));
  }
  return (template.studentIds || [])
    .map((id) => getStudent(id))
    .filter(Boolean)
    .map((student) => ({ studentId: student.id, name: student.name, status: "present" }));
}

function renderLessonPickers() {
  const hasTemplate = !!activeTemplate;
  $("selectedLessonSummary").classList.toggle("hidden", !hasTemplate);
  $("attendancePanel").classList.toggle("hidden", !hasTemplate);
  if (!hasTemplate) {
    $("selectedLessonSummary").innerHTML = "";
    $("attendanceList").innerHTML = "";
    $("trialStudentsWrap").classList.add("hidden");
    renderAttendanceSummary();
    return;
  }
  const classItem = activeTemplate.courseType === "classCourse" ? getClass(activeTemplate.classId) : null;
  const student = activeTemplate.courseType === "oneToOne" ? getStudent((activeTemplate.studentIds || [])[0]) : null;
  const className = classItem?.name || activeTemplate.className || "";
  const tag = classItem?.institutionTag || student?.institutionTag || "";
  $("selectedLessonSummary").innerHTML = `
    <strong>${h(activeTemplate.name)}</strong>
    <span>${h(COURSE_TYPES[activeTemplate.courseType])}｜${h(activeTemplate.grade)}${className ? `｜${h(className)}` : ""}${tag ? `｜${h(tag)}` : ""}</span>
  `;
  $("allPresentBtn").classList.toggle("hidden", activeTemplate.courseType !== "classCourse");
  $("trialStudentsWrap").classList.toggle("hidden", activeTemplate.courseType !== "classCourse");
  $("attendanceList").innerHTML = lessonAttendance.length ? lessonAttendance.map((item) => {
    if (activeTemplate.courseType === "classCourse") {
      return `
        <button type="button" class="attendance-card ${item.status} ${item.isTrial ? "trial" : ""}" onclick="cycleAttendance('${item.studentId}')">
          <strong>${h(item.name)}</strong>
          <span>${item.isTrial ? `试听｜${STATUS_LABELS[item.status]}` : STATUS_LABELS[item.status]}</span>
        </button>
      `;
    }
    return `
      <div class="attendance-card present static">
        <strong>${h(item.name)}</strong>
        <span>到课</span>
      </div>
    `;
  }).join("") : `<div class="empty">这个模板还没有可点名的学生。</div>`;
  renderAttendanceSummary();
}

function renderAttendanceSummary() {
  const counts = attendanceCounts(lessonAttendance);
  $("attendanceSummary").textContent = `总人数：${lessonAttendance.length}　到课：${counts.present}　请假：${counts.leave}　缺席：${counts.absent}`;
}

function cycleAttendance(studentId) {
  if (!activeTemplate || activeTemplate.courseType !== "classCourse") return;
  lessonAttendance = lessonAttendance.map((item) => {
    if (item.studentId !== studentId) return item;
    const next = STATUS_ORDER[(STATUS_ORDER.indexOf(item.status) + 1) % STATUS_ORDER.length];
    return { ...item, status: next };
  });
  renderLessonPickers();
  updateLessonCalculation();
}

function syncTrialStudents() {
  if (!activeTemplate || activeTemplate.courseType !== "classCourse") return;
  const existing = lessonAttendance.filter((item) => !item.isTrial);
  const trials = parseTrialStudentNames($("trialStudentsInput").value).map((name, index) => ({
    studentId: `trial-${index}`,
    name,
    status: "present",
    isTrial: true
  }));
  lessonAttendance = [...existing, ...trials];
  renderLessonPickers();
  updateLessonCalculation();
}

function parseTrialStudentNames(value) {
  return [...new Set(String(value || "")
    .split(/[\n,，、;；\s]+/)
    .map((name) => name.trim())
    .filter(Boolean))];
}

function getSelectedLessonData() {
  const attendance = lessonAttendance.map((item) => ({ ...item }));
  const selectedClass = activeTemplate?.courseType === "classCourse" ? getClass(activeTemplate.classId) : null;
  const selectedStudents = activeTemplate?.courseType === "oneToOne"
    ? (activeTemplate?.studentIds || [])
      .map((id) => getStudent(id))
      .filter(Boolean)
    : [];
  return {
    grade: activeTemplate?.grade || "",
    courseType: activeTemplate?.courseType || "",
    selectedStudents,
    selectedClass,
    attendance,
    manualAmount: numberOrNull($("manualAmount").value),
    settings: state.settings
  };
}

function calculateWage({ grade, courseType, selectedStudents, selectedClass, attendance, manualAmount, settings }) {
  const standards = settings.standards;
  const defaultExtra = settings.defaultSmallExtra ?? 10;
  const warnings = [];
  const presentCount = attendance.filter((item) => item.status === "present").length;
  if (manualAmount !== null) {
    return { amount: manualAmount, source: `手动改价：本次实际工资 ${manualAmount} 元`, warnings };
  }
  if (!grade || !standards[grade]) return { amount: 0, source: "请选择课程模板", warnings: ["请选择课程模板"] };

  if (courseType === "oneToOne") {
    if (selectedStudents.length !== 1) warnings.push("一对一模板必须关联 1 名个人学生");
    const student = selectedStudents[0];
    if (!student) return { amount: 0, source: "请选择课程模板", warnings };
    if (student.specialOne !== null && student.specialOne !== undefined) {
      return { amount: student.specialOne, source: `学生特殊价：${student.name}一对一特殊价格 ${student.specialOne} 元`, warnings };
    }
    const amount = standards[grade].oneToOne;
    return { amount, source: `默认价格：${grade}一对一 ${amount} 元`, warnings };
  }

  if (courseType === "classCourse") {
    if (presentCount < 2) warnings.push("班课到课人数少于 2 人，建议填写本次实际工资后保存");
    if (activeTemplate?.fixedMode === "fixed" && activeTemplate.fixedPrice !== null && activeTemplate.fixedPrice !== undefined) {
      return { amount: activeTemplate.fixedPrice, source: `模板固定价：${activeTemplate.name}固定价格 ${activeTemplate.fixedPrice} 元`, warnings };
    }
    const extra = selectedClass?.extraPerStudent ?? defaultExtra;
    const extraCount = Math.max(presentCount - 2, 0);
    if (selectedClass && selectedClass.smallBasePrice !== null && selectedClass.smallBasePrice !== undefined) {
      return { amount: selectedClass.smallBasePrice, source: `班级固定价：${selectedClass.name}固定价格 ${selectedClass.smallBasePrice} 元`, warnings };
    }
    const base = standards[grade].oneToTwo;
    const amount = base + extraCount * extra;
    return { amount, source: `默认价格：${grade}班课，到课 ${presentCount} 人，${base} + ${extraCount * extra} = ${amount} 元`, warnings };
  }
  return { amount: 0, source: "未识别课程类型", warnings: ["未识别课程类型"] };
}

function updateLessonCalculation() {
  if (!activeTemplate) {
    $("computedAmount").textContent = money(0);
    $("priceSource").textContent = "请选择课程模板后自动计算";
    $("calcWarning").classList.add("hidden");
    return;
  }
  const result = calculateWage(getSelectedLessonData());
  $("computedAmount").textContent = money(result.amount);
  $("priceSource").textContent = result.source;
  $("calcWarning").innerHTML = result.warnings.map(h).join("<br>");
  $("calcWarning").classList.toggle("hidden", result.warnings.length === 0);
}

function saveLesson(event) {
  event.preventDefault();
  if (!activeTemplate) return alert("请选择课程模板。");
  const data = getSelectedLessonData();
  const result = calculateWage(data);
  const hasManual = data.manualAmount !== null;
  if (result.warnings.length && !hasManual) return alert(`${result.warnings.join("；")}。如确实要保存，请填写本次实际工资。`);
  if (state.records.some((record) => record.date === $("lessonDate").value && record.templateId === activeTemplate.id && record.id !== $("lessonId").value)) {
    if (!confirm("今天已经记录过这节课，是否继续保存？")) return;
  }
  const counts = attendanceCounts(data.attendance);
  const id = $("lessonId").value || uid();
  const record = {
    id,
    date: $("lessonDate").value,
    templateId: activeTemplate.id,
    courseName: activeTemplate.name,
    courseType: activeTemplate.courseType,
    grade: activeTemplate.grade,
    institutionTag: data.selectedClass?.institutionTag || data.selectedStudents[0]?.institutionTag || "",
    classId: data.selectedClass?.id || "",
    className: data.selectedClass?.name || "",
    studentIds: data.attendance.filter((item) => item.status === "present").map((item) => item.studentId),
    attendance: data.attendance,
    attendanceCount: counts.present,
    leaveCount: counts.leave,
    absentCount: counts.absent,
    amount: result.amount,
    priceSource: result.source,
    manualAmount: data.manualAmount,
    note: $("lessonNote").value.trim(),
    confirmed: state.records.find((item) => item.id === id)?.confirmed || false
  };
  const index = state.records.findIndex((item) => item.id === id);
  if (index >= 0) state.records[index] = record;
  else state.records.push(record);
  const template = state.courseTemplates.find((item) => item.id === activeTemplate.id);
  if (template) template.lastUsedAt = new Date().toISOString();
  state.records.sort((a, b) => b.date.localeCompare(a.date));
  const keepDate = $("lessonDate").value;
  saveState();
  resetLessonForm(keepDate);
}

function resetLessonForm(keepDate = $("lessonDate").value || today()) {
  $("lessonId").value = "";
  $("selectedTemplateId").value = "";
  $("lessonDate").value = keepDate;
  $("manualAmount").value = "";
  $("lessonNote").value = "";
  $("trialStudentsInput").value = "";
  activeTemplate = null;
  lessonAttendance = [];
  renderLessonTemplates();
  renderLessonPickers();
  updateLessonCalculation();
}

function editLesson(id) {
  const record = state.records.find((item) => item.id === id);
  if (!record) return;
  activeTemplate = state.courseTemplates.find((item) => item.id === record.templateId) || {
    id: record.templateId || "",
    name: record.courseName || "历史记录",
    courseType: record.courseType,
    grade: record.grade,
    studentIds: record.studentIds || [],
    classId: record.classId || "",
    className: record.className || "",
    enabled: true
  };
  $("lessonId").value = record.id;
  $("selectedTemplateId").value = activeTemplate.id || "";
  $("lessonDate").value = record.date;
  $("manualAmount").value = record.manualAmount ?? "";
  $("lessonNote").value = record.note || "";
  lessonAttendance = normalizedAttendance(record);
  $("trialStudentsInput").value = lessonAttendance.filter((item) => item.isTrial).map((item) => item.name).join("、");
  switchTab("record");
  renderLessonTemplates();
  renderLessonPickers();
  updateLessonCalculation();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function deleteLesson(id) {
  if (!confirm("确定删除这条上课记录吗？")) return;
  state.records = state.records.filter((item) => item.id !== id);
  saveState();
}

function toggleRecordConfirmed(id) {
  const record = state.records.find((item) => item.id === id);
  if (!record) return;
  record.confirmed = !record.confirmed;
  saveState();
}

function toggleRecordGroupConfirmed(idsText) {
  const ids = idsText.split(",").filter(Boolean);
  const records = state.records.filter((record) => ids.includes(record.id));
  const shouldConfirm = records.some((record) => !record.confirmed);
  records.forEach((record) => {
    record.confirmed = shouldConfirm;
  });
  saveState();
}

function saveTemplate(event) {
  event.preventDefault();
  const id = $("templateId").value || uid();
  const type = $("templateType").value;
  const studentIds = type === "oneToOne" ? selectedTemplateStudentIds() : [];
  const classId = type === "classCourse" ? $("templateClass").value : "";
  if (type === "oneToOne" && studentIds.length !== 1) return alert("一对一模板必须关联 1 个个人学生。");
  if (type === "classCourse" && !classId) return alert("班课模板必须关联 1 个班级。");
  const templateName = $("templateName").value.trim() || suggestedTemplateName();
  if (!templateName) return alert("请选择学生或班级，系统会自动生成课程名称。");
  $("templateName").value = templateName;
  const template = {
    id,
    name: templateName,
    courseType: type,
    sourceType: type === "classCourse" ? "class" : "personal",
    grade: $("templateGrade").value,
    studentIds,
    classId,
    className: getClass(classId)?.name || "",
    fixedMode: $("templateBillingMode").value,
    fixedPrice: numberOrNull($("templateFixedPrice").value),
    enabled: $("templateEnabled").checked,
    sortOrder: state.courseTemplates.find((item) => item.id === id)?.sortOrder ?? 100,
    note: $("templateNote").value.trim(),
    lastUsedAt: state.courseTemplates.find((item) => item.id === id)?.lastUsedAt || ""
  };
  const index = state.courseTemplates.findIndex((item) => item.id === id);
  if (index >= 0) state.courseTemplates[index] = template;
  else state.courseTemplates.push(template);
  resetTemplateForm();
  saveState();
}

function resetTemplateForm() {
  $("templateId").value = "";
  $("templateName").value = "";
  $("templateName").dataset.manualName = "false";
  $("templateName").dataset.suggestedName = "";
  $("templateType").value = "oneToOne";
  $("templateGrade").value = GRADES[0];
  $("templateClass").value = "";
  $("templateBillingMode").value = "auto";
  $("templateFixedPrice").value = "";
  $("templateNote").value = "";
  $("templateEnabled").checked = true;
  renderTemplateFormPickers();
}

function renderTemplateFormPickers() {
  const type = $("templateType").value;
  const grade = $("templateGrade").value;
  const selectedClassId = $("templateClass").value;
  const isClass = type === "classCourse";
  $("templateClassWrap").classList.toggle("hidden", !isClass);
  $("templateBillingWrap").classList.toggle("hidden", !isClass);
  $("templateFixedPriceWrap").classList.toggle("hidden", !isClass || $("templateBillingMode").value !== "fixed");
  $("templateStudentsWrap").classList.toggle("hidden", isClass);
  const classOptions = state.classes.filter((item) => item.grade === grade);
  $("templateClass").innerHTML = `<option value="">${classOptions.length ? "选择班级" : `当前年级还没有班级`}</option>` + classOptions
    .map((item) => `<option value="${item.id}">${h(item.name)}（${h(item.grade)}）</option>`)
    .join("");
  if (classOptions.some((item) => item.id === selectedClassId)) $("templateClass").value = selectedClassId;
  const selectedIds = selectedTemplateStudentIds();
  $("templateStudentHint").textContent = "一对一请选择 1 名学生";
  const students = state.students.filter((student) => student.grade === grade);
  $("templateStudents").innerHTML = students.length ? students.map((student) => `
    <label class="check-card">
      <input type="checkbox" value="${student.id}" ${selectedIds.includes(student.id) ? "checked" : ""}>
      <span>${h(student.name)}</span>
    </label>
  `).join("") : `<div class="empty">当前年级还没有个人学生。</div>`;
  $("templateStudents").querySelectorAll("input").forEach((input) => {
    input.addEventListener("change", (event) => {
      const limit = 1;
      const checked = Array.from($("templateStudents").querySelectorAll("input:checked"));
      if (checked.length > limit) event.target.checked = false;
      syncTemplateNameWithSelection();
    });
  });
  syncTemplateNameWithSelection();
}

function selectedTemplateStudentIds() {
  return Array.from($("templateStudents").querySelectorAll("input:checked")).map((input) => input.value);
}

function suggestedTemplateName() {
  const type = $("templateType").value;
  if (type === "classCourse") return getClass($("templateClass").value)?.name || "";
  const studentId = selectedTemplateStudentIds()[0];
  return getStudent(studentId)?.name || "";
}

function syncTemplateNameWithSelection({ force = false } = {}) {
  const input = $("templateName");
  const suggestion = suggestedTemplateName();
  const previousSuggestion = input.dataset.suggestedName || "";
  const current = input.value.trim();
  const isManual = input.dataset.manualName === "true";
  input.dataset.suggestedName = suggestion;
  if (!suggestion) return;
  if (force || !isManual || !current || current === previousSuggestion) {
    input.value = suggestion;
    input.dataset.manualName = "false";
  }
}

function updateTemplateNameManualState() {
  const input = $("templateName");
  const current = input.value.trim();
  const suggestion = input.dataset.suggestedName || suggestedTemplateName();
  input.dataset.manualName = current && current !== suggestion ? "true" : "false";
}

function renderTemplateList() {
  const templates = sortedTemplates(true);
  $("templateList").innerHTML = templates.length ? TYPE_GROUPS.map(([type, label]) => {
    const group = templates.filter((template) => template.courseType === type);
    if (!group.length) return "";
    return `
      <div class="template-list-group">
        <h3>${label}</h3>
        ${group.map((template) => {
    const names = template.courseType === "classCourse"
      ? (getClass(template.classId)?.name || template.className || "")
      : (template.studentIds || []).map((id) => getStudent(id)?.name || "已删除学生").join("、");
    return `
      <article class="item">
        <div class="item-head">
          <strong>${h(template.name)}</strong>
          <span class="muted">${template.enabled === false ? "停用" : "启用"}</span>
        </div>
        <p>${h(COURSE_TYPES[template.courseType])}｜${h(template.grade)}｜${h(names || "未关联")}</p>
        ${template.note ? `<p>${h(template.note)}</p>` : ""}
        <div class="item-actions">
          <button class="secondary small" onclick="editTemplate('${template.id}')">编辑</button>
          <button class="danger small" onclick="deleteTemplate('${template.id}')">删除</button>
        </div>
      </article>
    `;
        }).join("")}
      </div>
    `;
  }).join("") : `<div class="empty">还没有课程模板。</div>`;
}

function editTemplate(id) {
  const template = state.courseTemplates.find((item) => item.id === id);
  if (!template) return;
  $("templateId").value = template.id;
  $("templateName").value = template.name;
  $("templateType").value = template.courseType;
  $("templateGrade").value = template.grade;
  $("templateNote").value = template.note || "";
  $("templateBillingMode").value = template.fixedMode || "auto";
  $("templateFixedPrice").value = template.fixedPrice ?? "";
  $("templateEnabled").checked = template.enabled !== false;
  $("templateName").dataset.manualName = "true";
  $("templateName").dataset.suggestedName = "";
  renderTemplateFormPickers();
  $("templateClass").value = template.classId || "";
  $("templateStudents").querySelectorAll("input").forEach((input) => {
    input.checked = (template.studentIds || []).includes(input.value);
  });
  const suggestion = suggestedTemplateName();
  $("templateName").dataset.suggestedName = suggestion;
  $("templateName").dataset.manualName = template.name && template.name !== suggestion ? "true" : "false";
  syncTemplateNameWithSelection();
  switchTab("templates");
}

function deleteTemplate(id) {
  if (!confirm("确定删除这个课程模板吗？历史上课记录不会删除。")) return;
  state.courseTemplates = state.courseTemplates.filter((item) => item.id !== id);
  if (activeTemplate?.id === id) resetLessonForm();
  saveState();
}

function saveStudent(event) {
  event.preventDefault();
  const id = $("studentId").value || uid();
  const student = {
    id,
    name: $("studentName").value.trim(),
    grade: $("studentGrade").value,
    institutionTag: normalizeTag($("studentTag").value),
    specialOne: numberOrNull($("specialOne").value),
    note: $("studentNote").value.trim()
  };
  if (!student.name) return alert("请填写学生姓名。");
  const index = state.students.findIndex((item) => item.id === id);
  if (index >= 0) state.students[index] = student;
  else state.students.push(student);
  resetStudentForm();
  saveState();
}

function resetStudentForm() {
  $("studentId").value = "";
  $("studentName").value = "";
  $("studentGrade").value = GRADES[0];
  $("studentTag").value = "";
  $("specialOne").value = "";
  $("studentNote").value = "";
}

function renderStudents() {
  const keyword = $("studentSearch").value.trim().toLowerCase();
  const grade = $("studentGradeFilter").value;
  const students = state.students.filter((student) => {
    if (keyword && !student.name.toLowerCase().includes(keyword)) return false;
    if (grade && student.grade !== grade) return false;
    return true;
  });
  $("studentList").innerHTML = students.length ? students.map((student) => {
    const specials = student.specialOne !== null ? `一对一特殊价 ${student.specialOne}` : "使用默认价格";
    return `
      <article class="item">
        <div class="item-head">
          <strong>${h(student.name)}</strong>
          <span class="muted">${h([student.grade, student.institutionTag].filter(Boolean).join("｜"))}</span>
        </div>
        <p>${h(specials)}</p>
        ${student.note ? `<p>${h(student.note)}</p>` : ""}
        <div class="item-actions">
          <button class="secondary small" onclick="editStudent('${student.id}')">编辑</button>
          <button class="danger small" onclick="deleteStudent('${student.id}')">删除</button>
        </div>
      </article>
    `;
  }).join("") : `<div class="empty">没有符合条件的个人学生。</div>`;
}

function editStudent(id) {
  const student = getStudent(id);
  if (!student) return;
  $("studentId").value = student.id;
  $("studentName").value = student.name;
  $("studentGrade").value = student.grade;
  $("studentTag").value = student.institutionTag || "";
  $("specialOne").value = student.specialOne ?? "";
  $("studentNote").value = student.note || "";
  switchTab("students");
}

function deleteStudent(id) {
  if (!confirm("确定删除这个个人学生吗？相关课程模板会失去关联。")) return;
  state.students = state.students.filter((item) => item.id !== id);
  state.courseTemplates = state.courseTemplates.map((template) => ({ ...template, studentIds: (template.studentIds || []).filter((studentId) => studentId !== id) }));
  saveState();
}

function addBulkClassStudents() {
  const names = parseNames($("classBulkStudents").value);
  if (!names.length) return;
  const existing = new Set(editingClassStudents.map((item) => item.name));
  names.forEach((name) => {
    if (existing.has(name)) return;
    existing.add(name);
    editingClassStudents.push({ id: uid(), name, status: "active", note: "" });
  });
  $("classBulkStudents").value = "";
  renderClassStudentList();
}

function parseNames(text) {
  return [...new Set(String(text || "")
    .split(/[\n\r、,，\s]+/)
    .map((name) => name.trim())
    .filter(Boolean))];
}

function renderClassStudentList() {
  $("classStudentList").innerHTML = editingClassStudents.length ? editingClassStudents.map((student) => `
    <div class="class-student-row ${student.status === "inactive" ? "is-inactive" : ""}">
      <input value="${h(student.name)}" oninput="updateClassStudentName('${student.id}', this.value)">
      <input value="${h(student.note || "")}" placeholder="备注" oninput="updateClassStudentNote('${student.id}', this.value)">
      <span>${student.status === "inactive" ? "停用" : "在读"}</span>
      <button type="button" class="secondary small" onclick="toggleClassStudent('${student.id}')">${student.status === "inactive" ? "恢复" : "停用"}</button>
      <button type="button" class="danger small" onclick="deleteClassStudent('${student.id}')">删除</button>
    </div>
  `).join("") : `<div class="empty">还没有班级学生。可以批量输入姓名后添加。</div>`;
}

function updateClassStudentName(id, value) {
  editingClassStudents = editingClassStudents.map((item) => item.id === id ? { ...item, name: value.trim() } : item);
}

function updateClassStudentNote(id, value) {
  editingClassStudents = editingClassStudents.map((item) => item.id === id ? { ...item, note: value.trim() } : item);
}

function toggleClassStudent(id) {
  editingClassStudents = editingClassStudents.map((item) => item.id === id ? { ...item, status: item.status === "inactive" ? "active" : "inactive" } : item);
  renderClassStudentList();
}

function deleteClassStudent(id) {
  if (!confirm("确定删除这个班级学生吗？历史记录中已保存的姓名不会丢失。")) return;
  editingClassStudents = editingClassStudents.filter((item) => item.id !== id);
  renderClassStudentList();
}

function saveClass(event) {
  event.preventDefault();
  addBulkClassStudents();
  const id = $("classId").value || uid();
  const classItem = {
    id,
    name: $("className").value.trim(),
    grade: $("classGrade").value,
    institutionTag: normalizeTag($("classTag").value),
    students: editingClassStudents.filter((student) => student.name).map((student) => ({ ...student })),
    smallBasePrice: numberOrNull($("classBasePrice").value),
    extraPerStudent: numberOrNull($("classExtraPrice").value) ?? 10,
    note: $("classNote").value.trim()
  };
  if (!classItem.name) return alert("请填写班级名称。");
  const index = state.classes.findIndex((item) => item.id === id);
  if (index >= 0) state.classes[index] = classItem;
  else state.classes.push(classItem);
  resetClassForm();
  saveState();
}

function resetClassForm(shouldRender = true) {
  $("classId").value = "";
  $("className").value = "";
  $("classGrade").value = GRADES[0];
  $("classTag").value = "";
  $("classBasePrice").value = "";
  $("classExtraPrice").value = "10";
  $("classBulkStudents").value = "";
  $("classNote").value = "";
  editingClassStudents = [];
  if (shouldRender) renderClassStudentList();
}

function renderClasses() {
  $("classList").innerHTML = state.classes.length ? state.classes.map((classItem) => {
    const active = (classItem.students || []).filter((student) => student.status !== "inactive");
    const inactive = (classItem.students || []).filter((student) => student.status === "inactive");
    const price = classItem.smallBasePrice !== null ? `班课固定价 ${classItem.smallBasePrice}，每人加 ${classItem.extraPerStudent ?? 10}` : "使用默认班课规则";
    return `
      <article class="item">
        <div class="item-head">
          <strong>${h(classItem.name)}</strong>
          <span class="muted">${h([classItem.grade, classItem.institutionTag].filter(Boolean).join("｜"))}</span>
        </div>
        <p>${h(price)}</p>
        <p>在读：${h(active.map((student) => student.name).join("、") || "暂无")}</p>
        ${inactive.length ? `<p>停用：${h(inactive.map((student) => student.name).join("、"))}</p>` : ""}
        ${classItem.note ? `<p>${h(classItem.note)}</p>` : ""}
        <div class="item-actions">
          <button class="secondary small" onclick="editClass('${classItem.id}')">编辑</button>
          <button class="danger small" onclick="deleteClass('${classItem.id}')">删除</button>
        </div>
      </article>
    `;
  }).join("") : `<div class="empty">还没有班级资料。</div>`;
}

function editClass(id) {
  const classItem = getClass(id);
  if (!classItem) return;
  $("classId").value = classItem.id;
  $("className").value = classItem.name;
  $("classGrade").value = classItem.grade;
  $("classTag").value = classItem.institutionTag || "";
  $("classBasePrice").value = classItem.smallBasePrice ?? "";
  $("classExtraPrice").value = classItem.extraPerStudent ?? 10;
  $("classNote").value = classItem.note || "";
  $("classBulkStudents").value = "";
  editingClassStudents = clone(classItem.students || []);
  renderClassStudentList();
  switchTab("classes");
}

function deleteClass(id) {
  if (!confirm("确定删除这个班级吗？相关课程模板会失去关联。")) return;
  state.classes = state.classes.filter((item) => item.id !== id);
  state.courseTemplates = state.courseTemplates.map((template) => template.classId === id ? { ...template, classId: "" } : template);
  saveState();
}

function renderStats() {
  const todayDate = today();
  const month = $("filterMonth").value || currentMonth();
  const filterDate = $("filterDate").value;
  const filterTag = $("filterTag").value;
  const todayRecords = state.records.filter((record) => record.date === todayDate);
  const monthRecords = state.records.filter((record) => record.date.startsWith(month));
  const displayRecords = state.records.filter((record) => {
    if (filterDate ? record.date !== filterDate : !record.date.startsWith(month)) return false;
    if (filterTag && recordInstitutionTag(record) !== filterTag) return false;
    return true;
  });
  renderStatNumbers(todayRecords, monthRecords, displayRecords);
  renderTodayRecords(todayRecords);
  renderRecordTable(displayRecords);
}

function renderTagFilter() {
  const select = $("filterTag");
  const current = select.value;
  const tags = availableInstitutionTags();
  select.innerHTML = `<option value="">全部机构</option>` + tags.map((tag) => `<option value="${h(tag)}">${h(tag)}</option>`).join("");
  if (tags.includes(current)) select.value = current;
}

function renderStatNumbers(todayRecords, monthRecords, displayRecords) {
  $("todayTotal").textContent = money(sum(todayRecords));
  $("todayCount").textContent = todayRecords.length;
  $("todayOneTotal").textContent = money(sum(todayRecords.filter((record) => record.courseType === "oneToOne")));
  $("todayClassTotal").textContent = money(sum(todayRecords.filter((record) => record.courseType === "classCourse")));
  $("statsTodayTotal").textContent = money(sum(todayRecords));
  $("statsMonthTotal").textContent = money(sum(monthRecords));
  $("statsTotal").textContent = money(sum(displayRecords));
  $("statsCount").textContent = displayRecords.length;
  $("oneTotal").textContent = money(sum(displayRecords.filter((record) => record.courseType === "oneToOne")));
  $("classTotal").textContent = money(sum(displayRecords.filter((record) => record.courseType === "classCourse")));
  $("oneCount").textContent = `${displayRecords.filter((record) => record.courseType === "oneToOne").length} 次`;
  $("classCount").textContent = `${displayRecords.filter((record) => record.courseType === "classCourse").length} 次`;
}

function renderTodayRecords(records) {
  $("todayRecords").innerHTML = records.length ? records.map((record) => {
    const counts = attendanceCounts(normalizedAttendance(record));
    return `
      <article class="compact-item">
        <strong>${h(record.courseName || COURSE_TYPES[record.courseType])} ${money(record.amount)}</strong>
        <p>${h(record.grade)}｜到课 ${counts.present}｜请假 ${counts.leave}｜缺席 ${counts.absent}</p>
        <p>${h(record.priceSource)}</p>
        ${record.note ? `<p>${h(record.note)}</p>` : ""}
      </article>
    `;
  }).join("") : `<div class="empty">今天还没有记录。</div>`;
}

function renderRecordTable(records) {
  const groups = groupRecordsForStats(records);
  $("recordTable").innerHTML = groups.length ? groups.map((group) => {
    const latest = group.records[0];
    const counts = attendanceCounts(normalizedAttendance(latest));
    const allConfirmed = group.records.every((record) => record.confirmed);
    const recordIds = group.records.map((record) => record.id).join(",");
    return `
      <tr>
        <td>${h(group.dateText)}</td>
        <td>${h(latest.courseName || "")}</td>
        <td>${COURSE_TYPES[latest.courseType]}</td>
        <td>${h(latest.grade)}</td>
        <td>${h(group.institutionTag || "未分类")}</td>
        <td>${h(latest.className || "")}</td>
        <td>
          <div>最近一次到课：${h(attendanceNames(latest, "present") || "-")}</div>
          <div class="muted">请假：${h(attendanceNames(latest, "leave") || "-")}</div>
          <div class="muted">缺席：${h(attendanceNames(latest, "absent") || "-")}</div>
        </td>
        <td>${counts.present}</td>
        <td>${counts.leave}</td>
        <td>${counts.absent}</td>
        <td><strong>${group.count}</strong></td>
        <td><strong>${money(group.totalAmount)}</strong></td>
        <td>${h(latest.priceSource)}</td>
        <td>${h(latest.note || "")}</td>
        <td><button class="secondary small" onclick="toggleRecordGroupConfirmed('${recordIds}')">${allConfirmed ? "已确认" : "有未确认"}</button></td>
        <td>
          <div class="group-actions">
            ${group.records.map((record) => `
              <div class="group-action-row">
                <span>${h(record.date)} ${money(record.amount)}</span>
                <button class="secondary small" onclick="editLesson('${record.id}')">编辑</button>
                <button class="danger small" onclick="deleteLesson('${record.id}')">删除</button>
              </div>
            `).join("")}
          </div>
        </td>
      </tr>
    `;
  }).join("") : `<tr><td colspan="16">暂无明细。</td></tr>`;
}

function groupRecordsForStats(records) {
  const groups = new Map();
  records.forEach((record) => {
    const tag = recordInstitutionTag(record);
    const key = `${tag}|${record.templateId || `${record.courseName || ""}|${record.courseType}|${record.grade}|${record.className || ""}`}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  });
  return Array.from(groups.values()).map((items) => {
    const sorted = [...items].sort((a, b) => b.date.localeCompare(a.date));
    const dates = [...new Set(sorted.map((record) => record.date))].sort();
    return {
      records: sorted,
      count: sorted.length,
      totalAmount: sum(sorted),
      allConfirmed: sorted.every((record) => record.confirmed),
      institutionTag: recordInstitutionTag(sorted[0]),
      dateText: dates.length === 1 ? dates[0] : `${dates[0]} 至 ${dates[dates.length - 1]}`
    };
  }).sort((a, b) => {
    if (a.allConfirmed !== b.allConfirmed) return a.allConfirmed ? 1 : -1;
    return b.records[0].date.localeCompare(a.records[0].date);
  });
}

function exportCurrentMonthCsv() {
  const month = $("filterMonth").value || currentMonth();
  const filterTag = $("filterTag").value;
  const records = state.records.filter((record) => record.date.startsWith(month) && (!filterTag || recordInstitutionTag(record) === filterTag));
  const groups = groupRecordsForStats(records);
  const headers = ["日期范围", "课程名称", "类型", "年级", "机构标签", "学生/班级", "次数", "总工资", "确认状态", "备注"];
  const rows = groups.map((group) => {
    const latest = group.records[0];
    const name = latest.courseType === "classCourse"
      ? latest.className || latest.courseName || ""
      : latest.courseName || latest.studentName || "";
    const notes = [...new Set(group.records.map((record) => record.note || "").filter(Boolean))].join("；");
    return [
      group.dateText,
      latest.courseName || "",
      COURSE_TYPES[latest.courseType],
      latest.grade,
      group.institutionTag || "未分类",
      name,
      group.count,
      group.totalAmount,
      group.allConfirmed ? "已确认" : "有未确认",
      notes
    ];
  });
  downloadBlob("\ufeff" + [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n"), `${month}-工资汇总.csv`, "text/csv;charset=utf-8");
}

function exportJsonBackup() {
  downloadBlob(JSON.stringify(state, null, 2), `工资统计备份-${today()}.json`, "application/json;charset=utf-8");
}

function importJsonBackup(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!confirm("导入备份会替换当前账号的云端数据，确定继续吗？")) return;
      state = migrateState({
        students: data.students || [],
        classes: data.classes || [],
        courseTemplates: data.courseTemplates || [],
        records: data.records || [],
        settings: data.settings || { standards: clone(DEFAULT_STANDARDS), defaultSmallExtra: 10 }
      });
      activeTemplate = null;
      lessonAttendance = [];
      saveState();
      resetLessonForm(today());
      alert("备份已导入。");
    } catch {
      alert("备份文件格式不正确。");
    } finally {
      event.target.value = "";
    }
  };
  reader.readAsText(file, "utf-8");
}

function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function renderSettings() {
  $("standardsTable").innerHTML = GRADES.map((grade) => `
    <tr>
      <td>${grade}</td>
      <td><input data-grade="${grade}" data-type="oneToOne" type="number" min="0" step="1" value="${state.settings.standards[grade].oneToOne}"></td>
      <td><input data-grade="${grade}" data-type="oneToTwo" type="number" min="0" step="1" value="${state.settings.standards[grade].oneToTwo}"></td>
    </tr>
  `).join("");
  $("defaultSmallExtra").value = state.settings.defaultSmallExtra ?? 10;
}

function saveStandards() {
  const standards = clone(state.settings.standards);
  $("standardsTable").querySelectorAll("input").forEach((input) => {
    standards[input.dataset.grade][input.dataset.type] = Number(input.value || 0);
  });
  state.settings.standards = standards;
  state.settings.defaultSmallExtra = Number($("defaultSmallExtra").value || 10);
  saveState();
  alert("工资标准已保存，历史记录金额不会自动改变。");
}

function resetStandards() {
  if (!confirm("确定恢复默认工资标准吗？")) return;
  state.settings.standards = clone(DEFAULT_STANDARDS);
  state.settings.defaultSmallExtra = 10;
  saveState();
}

function getStudent(id) {
  return state.students.find((student) => student.id === id);
}

function getClass(id) {
  return state.classes.find((classItem) => classItem.id === id);
}

function normalizedAttendance(record) {
  if (Array.isArray(record.attendance) && record.attendance.length) return record.attendance;
  return (record.studentIds || []).map((id) => ({ studentId: id, name: getStudent(id)?.name || "已删除学生", status: "present" }));
}

function attendanceCounts(attendance) {
  return attendance.reduce((counts, item) => {
    counts[item.status] += 1;
    return counts;
  }, { present: 0, leave: 0, absent: 0 });
}

function attendanceNames(record, status) {
  return normalizedAttendance(record).filter((item) => item.status === status).map((item) => item.name).join("、");
}

function sum(records) {
  return records.reduce((total, record) => total + Number(record.amount || 0), 0);
}

function availableInstitutionTags() {
  return [...new Set([
    ...state.students.map((student) => student.institutionTag),
    ...state.classes.map((classItem) => classItem.institutionTag),
    ...state.records.map((record) => recordInstitutionTag(record))
  ].map(normalizeTag).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function recordInstitutionTag(record) {
  const savedTag = normalizeTag(record.institutionTag);
  if (savedTag) return savedTag;
  const classTag = normalizeTag(getClass(record.classId)?.institutionTag);
  if (classTag) return classTag;
  const template = state.courseTemplates.find((item) => item.id === record.templateId);
  if (template?.courseType === "classCourse") return normalizeTag(getClass(template.classId)?.institutionTag);
  const studentId = (template?.studentIds || record.studentIds || normalizedAttendance(record).map((item) => item.studentId)).filter(Boolean)[0];
  return normalizeTag(getStudent(studentId)?.institutionTag);
}

function updateHeaderTotal() {
  $("headerMonthTotal").textContent = money(sum(state.records.filter((record) => record.date.startsWith(currentMonth()))));
}

window.selectLessonTemplate = selectLessonTemplate;
window.cycleAttendance = cycleAttendance;
window.editLesson = editLesson;
window.deleteLesson = deleteLesson;
window.toggleRecordConfirmed = toggleRecordConfirmed;
window.toggleRecordGroupConfirmed = toggleRecordGroupConfirmed;
window.editTemplate = editTemplate;
window.deleteTemplate = deleteTemplate;
window.editStudent = editStudent;
window.deleteStudent = deleteStudent;
window.editClass = editClass;
window.deleteClass = deleteClass;
window.updateClassStudentName = updateClassStudentName;
window.updateClassStudentNote = updateClassStudentNote;
window.toggleClassStudent = toggleClassStudent;
window.deleteClassStudent = deleteClassStudent;

init();
