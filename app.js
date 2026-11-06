// ============================================================================
// GOSS VARDİYA MÜHENDİSLİĞİ ÇALIŞMA VE SINAV MOTORU
// IndexedDB (Soru/Test Deposu) + LocalStorage (İstatistik ve Hata Borcu)
// ============================================================================

const DB_NAME = "GOSS_QuestionBank_DB_v2";
const DB_VERSION = 1;
const STORE_NAME = "courses_store";

let appData = null; // Tüm dersler ve testler
let currentMode = "dashboard"; // 'dashboard' | 'study' | 'exam' | 'errors' | 'stars'
let currentCourseId = "hukuk";
let currentTestId = "test_1";
let searchQuery = "";

// Düzenleme Modalı İçin Geçici Referans
let editingTarget = null; // { courseId, testId, questionId, uniqueId }

// Deneme Sınavı Durumu
let activeExam = {
  questions: [],
  userChoices: {},
  timerInterval: null,
  remainingSeconds: 0,
  examType: "standard"
};

// ============================================================================
// 1. VERİTABANI (IndexedDB) BAŞLATMA VE SENKRONİZASYON
// ============================================================================
function openIndexedDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function loadDatabase() {
  try {
    const db = await openIndexedDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get("main_db");
      getReq.onsuccess = async () => {
        if (getReq.result && getReq.result.data) {
          resolve(getReq.result.data);
        } else {
          // İlk açılışta database.js içindeki başlangıç verisini yükle
          const initial = JSON.parse(JSON.stringify(window.INITIAL_DATABASE));
          await saveDatabase(initial);
          resolve(initial);
        }
      };
      getReq.onerror = () => resolve(JSON.parse(JSON.stringify(window.INITIAL_DATABASE)));
    });
  } catch (err) {
    return JSON.parse(JSON.stringify(window.INITIAL_DATABASE));
  }
}

async function saveDatabase(dataObj) {
  appData = dataObj;
  try {
    const db = await openIndexedDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.put({ id: "main_db", data: dataObj });
      tx.oncomplete = () => resolve();
    });
  } catch (e) {
    console.error("Veritabanı kayıt hatası:", e);
  }
}

// ============================================================================
// 2. KULLANICI İSTATİSTİKLERİ VE HATA BORCU (localStorage)
// ============================================================================
function getCourseStateKey(courseId) {
  return `goss_state_v2_${courseId}`;
}

function loadCourseState(courseId) {
  const raw = localStorage.getItem(getCourseStateKey(courseId));
  if (!raw) {
    return {
      answers: {},     // uniqueId -> "A" | "B" ...
      status: {},      // uniqueId -> "correct" | "wrong" | "revealed"
      errorCounts: {}, // uniqueId -> 1..5 (Hata havuzu tekrar borcu)
      stars: []        // [uniqueId, ...]
    };
  }
  const parsed = JSON.parse(raw);
  parsed.answers = parsed.answers || {};
  parsed.status = parsed.status || {};
  parsed.errorCounts = parsed.errorCounts || {};
  parsed.stars = parsed.stars || [];
  return parsed;
}

function saveCourseState(courseId, stateObj) {
  localStorage.setItem(getCourseStateKey(courseId), JSON.stringify(stateObj));
  pushToCloud(); // Her soru çözüldüğünde otomatik buluta yedekler
}

function loadExamHistory() {
  const raw = localStorage.getItem("goss_exam_history_v2");
  return raw ? JSON.parse(raw) : [];
}

function saveExamHistory(list) {
  localStorage.setItem("goss_exam_history_v2", JSON.stringify(list));
  pushToCloud(); // Her soru çözüldüğünde otomatik buluta yedekler
}

// ============================================================================
// 3. UYGULAMA BAŞLATICI
// ============================================================================
document.addEventListener("DOMContentLoaded", async () => {
  appData = await loadDatabase();
  await initCloudSync(); // Açılışta buluttaki son kayıtları çeker
  bindUIEvents();
  populateCourseSelectors();
  switchMode("dashboard");
});

function bindUIEvents() {
  // Tema Değiştir
  document.getElementById("themeToggleBtn").addEventListener("click", () => {
    document.body.classList.toggle("dark-mode");
  });

  // Sıfırlama Açılır Menüsü Tıklama Kontrolü
  const resetBtn = document.getElementById("resetMenuBtn");
  const resetMenu = document.getElementById("resetDropdownMenu");
  resetBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    resetMenu.classList.toggle("show");
  });
  document.addEventListener("click", () => resetMenu.classList.remove("show"));

  // Navigasyon Mod Butonları
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetMode = btn.getAttribute("data-mode");
      switchMode(targetMode);
    });
  });

  // Ders Seçimi Değiştiğinde
  document.getElementById("courseSelect").addEventListener("change", (e) => {
    currentCourseId = e.target.value;
    populateTestSelector();
    refreshActiveScreen();
  });

  // Test Seçimi Değiştiğinde
  document.getElementById("testSelect").addEventListener("change", (e) => {
    currentTestId = e.target.value;
    refreshActiveScreen();
  });

  // Arama Çubuğu
  const searchInput = document.getElementById("searchInput");
  const clearSearchBtn = document.getElementById("clearSearchBtn");
  searchInput.addEventListener("input", (e) => {
    searchQuery = e.target.value.trim();
    clearSearchBtn.classList.toggle("hidden", searchQuery.length === 0);
    renderQuestionListScreen();
  });
  clearSearchBtn.addEventListener("click", () => {
    searchInput.value = "";
    searchQuery = "";
    clearSearchBtn.classList.add("hidden");
    renderQuestionListScreen();
  });

  // Sıfırlama Seçenekleri
  document.getElementById("resetWrongsBtn").addEventListener("click", () => resetByCategory("wrong"));
  document.getElementById("resetRevealedBtn").addEventListener("click", () => resetByCategory("revealed"));
  document.getElementById("resetCorrectsBtn").addEventListener("click", () => resetByCategory("correct"));
  document.getElementById("resetActiveTestBtn").addEventListener("click", () => resetActiveTestOnly());
  document.getElementById("resetCourseAllBtn").addEventListener("click", () => resetEntireCourse());

  // Yeni Test Ekleme Modalı
  document.getElementById("openUploadModalBtn").addEventListener("click", openUploadModal);
  document.getElementById("closeUploadModalBtn").addEventListener("click", closeUploadModal);
  document.getElementById("cancelUploadBtn").addEventListener("click", closeUploadModal);
  document.getElementById("confirmUploadBtn").addEventListener("click", handleAddNewTest);

  // Seçili Testi Silme
  document.getElementById("deleteTestBtn").addEventListener("click", handleDeleteCurrentTest);

  // Canlı Soru Düzenleme Modalı
  document.getElementById("closeEditModalBtn").addEventListener("click", closeEditModal);
  document.getElementById("cancelEditBtn").addEventListener("click", closeEditModal);
  document.getElementById("saveEditQuestionBtn").addEventListener("click", handleSaveEditedQuestion);

  // Dışa Aktarma (Yedekleme ve Paylaşım)
  document.getElementById("exportDatabaseBtn").addEventListener("click", exportDatabaseJS);
  document.getElementById("exportCurrentTestBtn").addEventListener("click", exportSelectedTestJSON);

  // Deneme Sınavı Kontrolleri
  document.getElementById("startExamNowBtn").addEventListener("click", startTimedExam);
  document.getElementById("finishExamBtn").addEventListener("click", () => finishTimedExam(false));
  document.getElementById("clearExamHistoryBtn").addEventListener("click", () => {
    if (confirm("Tüm deneme sınavı geçmişi silinsin mi?")) {
      saveExamHistory([]);
      renderDashboard();
    }
  });
}

// ============================================================================
// 4. DERS VE TEST SEÇİCİLERİ YÖNETİMİ
// ============================================================================
function getCourseById(courseId) {
  return appData.courses.find((c) => c.id === courseId);
}

function populateCourseSelectors() {
  const select = document.getElementById("courseSelect");
  const uploadCourseSelect = document.getElementById("uploadCourseSelect");
  select.innerHTML = "";
  uploadCourseSelect.innerHTML = "";

  appData.courses.forEach((c) => {
    const opt1 = document.createElement("option");
    opt1.value = c.id;
    opt1.textContent = c.name;
    select.appendChild(opt1);

    const opt2 = document.createElement("option");
    opt2.value = c.id;
    opt2.textContent = c.name;
    uploadCourseSelect.appendChild(opt2);
  });

  select.value = currentCourseId;
  populateTestSelector();
}

function populateTestSelector() {
  const testSelect = document.getElementById("testSelect");
  testSelect.innerHTML = "";
  const course = getCourseById(currentCourseId);
  if (!course) return;

  // Hata Havuzu veya Yıldızlı Sorular modunda "Tüm Testleri Birleştir" seçeneği
  if (currentMode === "errors" || currentMode === "stars") {
    const optAll = document.createElement("option");
    optAll.value = "ALL_COMBINED";
    optAll.textContent = "⚡ Tüm Testlerin Birleşik Havuzu";
    testSelect.appendChild(optAll);
  }

  course.tests.forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = `${t.name} (${t.questions.length} Soru)`;
    testSelect.appendChild(opt);
  });

  if (currentMode === "errors" || currentMode === "stars") {
    currentTestId = "ALL_COMBINED";
  } else {
    currentTestId = course.tests.length > 0 ? course.tests[0].id : "";
  }
  testSelect.value = currentTestId;
}

function switchMode(mode) {
  // Eğer aktif bir sınav varsa ve çıkılıyorsa uyar
  if (activeExam.timerInterval && mode !== "exam") {
    if (!confirm("Aktif deneme sınavından çıkarsanız sınav iptal olur. Çıkmak istiyor musunuz?")) {
      return;
    }
    clearInterval(activeExam.timerInterval);
    activeExam.timerInterval = null;
  }

  currentMode = mode;
  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-mode") === mode);
  });

  populateTestSelector();
  refreshActiveScreen();
}

function refreshActiveScreen() {
  const dashView = document.getElementById("dashboardView");
  const qView = document.getElementById("questionsView");
  const examView = document.getElementById("examView");
  const testGroup = document.getElementById("testGroup");

  dashView.classList.add("hidden");
  qView.classList.add("hidden");
  examView.classList.add("hidden");

  updateSidebarStats();

  if (currentMode === "dashboard") {
    testGroup.classList.remove("hidden");
    dashView.classList.remove("hidden");
    renderDashboard();
  } else if (currentMode === "exam") {
    testGroup.classList.add("hidden");
    examView.classList.remove("hidden");
    renderExamSetup();
  } else {
    testGroup.classList.remove("hidden");
    qView.classList.remove("hidden");
    renderQuestionListScreen();
  }
}

// ============================================================================
// 5. SOL PANEL CANLI İSTATİSTİK HESAPLAMA
// ============================================================================
function updateSidebarStats() {
  const state = loadCourseState(currentCourseId);
  const pool = getQuestionsForCurrentSelection();
  let c = 0, w = 0, r = 0;

  pool.forEach((q) => {
    const st = state.status[q.uniqueId];
    if (st === "correct") c++;
    else if (st === "wrong") w++;
    else if (st === "revealed") r++;
  });

  document.getElementById("statCorrect").textContent = c;
  document.getElementById("statWrong").textContent = w;
  document.getElementById("statRevealed").textContent = r;
}

function getQuestionsForCurrentSelection() {
  const course = getCourseById(currentCourseId);
  if (!course) return [];

  let list = [];
  if (currentTestId === "ALL_COMBINED") {
    course.tests.forEach((t) => {
      t.questions.forEach((q) => {
        list.push({
          ...q,
          courseId: course.id,
          courseName: course.name,
          testId: t.id,
          testName: t.name,
          uniqueId: `${t.id}_${q.id}`
        });
      });
    });
  } else {
    const testObj = course.tests.find((t) => t.id === currentTestId);
    if (testObj) {
      testObj.questions.forEach((q) => {
        list.push({
          ...q,
          courseId: course.id,
          courseName: course.name,
          testId: testObj.id,
          testName: testObj.name,
          uniqueId: `${testObj.id}_${q.id}`
        });
      });
    }
  }
  return list;
}

// ============================================================================
// 6. GENEL İLERLEME PANELİ (DASHBOARD)
// ============================================================================
function renderDashboard() {
  const container = document.getElementById("dashboardCards");
  container.innerHTML = "";

  appData.courses.forEach((course) => {
    const state = loadCourseState(course.id);
    let totalQ = 0;
    let correctCount = 0;
    let wrongCount = 0;
    let revealedCount = 0;

    course.tests.forEach((t) => {
      t.questions.forEach((q) => {
        totalQ++;
        const uid = `${t.id}_${q.id}`;
        const st = state.status[uid];
        if (st === "correct") correctCount++;
        else if (st === "wrong") wrongCount++;
        else if (st === "revealed") revealedCount++;
      });
    });

    const solvedTotal = correctCount + wrongCount; // Sadece şık işaretlenenler çözüldü sayılır
    const card = document.createElement("div");
    card.className = "dash-card";
    card.innerHTML = `
      <h4>${course.name}</h4>
      <div class="dash-stat-line"><span>Toplam Test Sayısı:</span> <strong>${course.tests.length} Test</strong></div>
      <div class="dash-stat-line"><span>Toplam Soru Havuzu:</span> <strong>${totalQ} Soru</strong></div>
      <div class="dash-stat-line"><span>Çözülen (İşaretlenen):</span> <strong>${solvedTotal} / ${totalQ}</strong></div>
      <div class="dash-stat-line"><span style="color:var(--col-correct)">Doğru Çözülen:</span> <strong>${correctCount}</strong></div>
      <div class="dash-stat-line"><span style="color:var(--col-wrong)">Hata Havuzundaki:</span> <strong>${wrongCount}</strong></div>
      <div class="dash-stat-line"><span style="color:var(--col-revealed)">Cevabı Gösterilen:</span> <strong>${revealedCount}</strong></div>
      <div class="dash-stat-line"><span>⭐ Yıldızlı Soru:</span> <strong>${state.stars.length}</strong></div>
    `;
    container.appendChild(card);
  });

  // Sınav Geçmişi Tablosu
  const tbody = document.getElementById("examHistoryBody");
  const history = loadExamHistory();
  tbody.innerHTML = "";

  if (history.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted-text" style="text-align:center;">Henüz tamamlanmış deneme sınavı bulunmuyor.</td></tr>`;
    return;
  }

  history.slice().reverse().forEach((item) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${item.date}</td>
      <td>${item.courseName}</td>
      <td>${item.examType === "smart" ? "Akıllı (%35 Hata)" : "Standart Karma"}</td>
      <td>${item.correct} D / ${item.wrong} Y / ${item.empty} B</td>
      <td><strong>${item.score}</strong></td>
      <td><span class="${item.passed ? "pass-tag" : "fail-tag"}">${item.passed ? "GEÇTİ" : "KALDI"}</span></td>
    `;
    tbody.appendChild(tr);
  });
}

// ============================================================================
// 7. SORU LİSTELEME (SERBEST ÇALIŞMA / HATA HAVUZU / YILDIZLILAR)
// ============================================================================
function renderQuestionListScreen() {
  const course = getCourseById(currentCourseId);
  const state = loadCourseState(currentCourseId);
  let pool = getQuestionsForCurrentSelection();

  const heading = document.getElementById("viewHeading");
  const subheading = document.getElementById("viewSubheading");

  if (currentMode === "study") {
    // SERBEST ÇALIŞMA: Sıra ASLA karışmaz (her zaman 1'den N'e sabit sıra)
    heading.textContent = `${course.name} — Serbest Çalışma`;
    subheading.textContent = "Sorular sabit sırasıyla listelenir. 'Cevabı Göster' butonuna basmak soruyu Hata Havuzuna düşürmez.";
  } else if (currentMode === "errors") {
    // HATA HAVUZU: Sadece 'wrong' olanlar ve KARIŞIK sıra
    pool = pool.filter((q) => state.status[q.uniqueId] === "wrong");
    shuffleArray(pool);
    heading.textContent = `${course.name} — Hata Havuzu (Karışık Sıra)`;
    subheading.textContent = "Kaç kez hata yapıldıysa (maks. 5) o kadar doğru çözülünce havuzdan otomatik düşer.";
  } else if (currentMode === "stars") {
    pool = pool.filter((q) => state.stars.includes(q.uniqueId));
    heading.textContent = `${course.name} — Yıldızlı Sorular`;
    subheading.textContent = "Önemli olarak işaretlediğin sorular.";
  }

  // Arama Filtresi Uygulama
  if (searchQuery.length > 0) {
    const qLower = searchQuery.toLocaleLowerCase("tr-TR");
    pool = pool.filter((q) => {
      const matchId = String(q.id) === qLower || `soru ${q.id}` === qLower;
      const matchText = q.soru.toLocaleLowerCase("tr-TR").includes(qLower);
      const matchOpts = q.secenekler.some((opt) => opt.toLocaleLowerCase("tr-TR").includes(qLower));
      return matchId || matchText || matchOpts;
    });
  }

  document.getElementById("questionCountBadge").textContent = `${pool.length} Soru`;
  const container = document.getElementById("questionsContainer");
  container.innerHTML = "";

  if (pool.length === 0) {
    container.innerHTML = `
      <div class="question-card" style="text-align:center; color:var(--text-secondary);">
        Bu görünümde veya arama kriterinde soru bulunamadı.
      </div>
    `;
    return;
  }

  pool.forEach((q) => {
    const card = buildQuestionCard(q, state);
    container.appendChild(card);
  });
}

function buildQuestionCard(q, state) {
  const card = document.createElement("div");
  card.className = "question-card";

  const isStarred = state.stars.includes(q.uniqueId);
  const chosenAns = state.answers[q.uniqueId];
  const status = state.status[q.uniqueId];
  const debtCount = state.errorCounts[q.uniqueId] || 0;

  // Hata havuzunda sorunun tekrar çözülmesine izin verilir; serbest çalışmada işaretlendiyse gösterilir
  const allowClickInErrorMode = currentMode === "errors";

  card.innerHTML = `
    <div class="q-meta-bar">
      <div class="q-badges">
        <span class="source-badge">📌 ${q.courseName} • ${q.testName} • Soru ${q.id}</span>
        ${debtCount > 0 ? `<span class="debt-badge">⚠️ Kalan Pekiştirme Tekrarı: ${debtCount}</span>` : ""}
      </div>
      <div class="q-actions">
        <button class="edit-q-btn" title="Soruyu veya Cevabını Düzenle">✏️ Düzenle</button>
        <button class="star-btn ${isStarred ? "starred" : ""}" title="Yıldızla / İşaretle">★</button>
      </div>
    </div>

    <div class="q-body-text">${escapeHTML(q.soru)}</div>

    <div class="options-group">
      ${q.secenekler.map((optStr) => {
        const letter = optStr.trim().charAt(0).toUpperCase();
        let btnClass = "option-btn";
        let disabledAttr = "";

        if (!allowClickInErrorMode && chosenAns) {
          disabledAttr = "disabled";
          if (letter === q.dogru) btnClass += " correct-ans";
          else if (letter === chosenAns) btnClass += " wrong-ans";
        }
        return `<button class="${btnClass}" data-letter="${letter}" ${disabledAttr}>${escapeHTML(optStr)}</button>`;
      }).join("")}
    </div>

    <div class="q-footer-bar">
      <button class="reveal-btn">🔍 Cevabı Göster / Gizle</button>
      <div class="explanation-box ${status === "revealed" ? "open" : ""}">
        <strong>Doğru Cevap: ${q.dogru}</strong><br>
        <span>${escapeHTML(q.aciklama || "Bu soru için ek açıklama girilmemiş.")}</span>
      </div>
    </div>
  `;

  // Şık Tıklama Olayı
  const optButtons = card.querySelectorAll(".option-btn");
  optButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const selectedLetter = btn.getAttribute("data-letter");
      handleQuestionAnswer(q, selectedLetter, card, optButtons);
    });
  });

  // Cevabı Göster Butonu (Hata Havuzuna DÜŞÜRMEZ)
  const revealBtn = card.querySelector(".reveal-btn");
  const expBox = card.querySelector(".explanation-box");
  revealBtn.addEventListener("click", () => {
    expBox.classList.toggle("open");
    const freshState = loadCourseState(currentCourseId);
    // Eğer henüz doğru/yanlış işaretlenmemişse 'revealed' (Cevabı Gösterilen) olarak kaydet
    if (!freshState.status[q.uniqueId]) {
      freshState.status[q.uniqueId] = "revealed";
      saveCourseState(currentCourseId, freshState);
      updateSidebarStats();
    }
  });

  // Yıldızlama Butonu
  const starBtn = card.querySelector(".star-btn");
  starBtn.addEventListener("click", () => {
    toggleQuestionStar(q.courseId, q.uniqueId, starBtn);
  });

  // Canlı Soru Düzenleme Butonu
  const editBtn = card.querySelector(".edit-q-btn");
  editBtn.addEventListener("click", () => {
    openEditQuestionModal(q);
  });

  return card;
}

function handleQuestionAnswer(q, selectedLetter, cardElement, optButtons) {
  const state = loadCourseState(currentCourseId);
  const isCorrect = selectedLetter === q.dogru;

  // Kart üzerindeki şıkları anında renklendir
  optButtons.forEach((b) => {
    b.disabled = true;
    const l = b.getAttribute("data-letter");
    if (l === q.dogru) b.classList.add("correct-ans");
    else if (l === selectedLetter) b.classList.add("wrong-ans");
  });

  state.answers[q.uniqueId] = selectedLetter;
  let currentDebt = state.errorCounts[q.uniqueId] || 0;

  if (isCorrect) {
    if (currentMode === "errors") {
      // Hata havuzunda doğru bilindi: Borç 1 düşer
      currentDebt = Math.max(0, currentDebt - 1);
      state.errorCounts[q.uniqueId] = currentDebt;
      if (currentDebt === 0) {
        state.status[q.uniqueId] = "correct";
      }
      // Kart üzerindeki borç rozetini güncelle
      const debtBadge = cardElement.querySelector(".debt-badge");
      if (debtBadge) {
        debtBadge.textContent = currentDebt > 0
          ? `⚠️ Kalan Pekiştirme Tekrarı: ${currentDebt}`
          : "✔️ Pekiştirme Tamamlandı (Havuzdan Çıktı)";
      }
    } else {
      state.status[q.uniqueId] = "correct";
      state.errorCounts[q.uniqueId] = 0;
    }
  } else {
    // Yanlış işaretlendi: Hata havuzuna girer ve tekrar borcu 1 artar (Maksimum 5)
    currentDebt = Math.min(5, currentDebt + 1);
    state.errorCounts[q.uniqueId] = currentDebt;
    state.status[q.uniqueId] = "wrong";

    const badgesContainer = cardElement.querySelector(".q-badges");
    let debtBadge = cardElement.querySelector(".debt-badge");
    if (!debtBadge) {
      debtBadge = document.createElement("span");
      debtBadge.className = "debt-badge";
      badgesContainer.appendChild(debtBadge);
    }
    debtBadge.textContent = `⚠️ Kalan Pekiştirme Tekrarı: ${currentDebt}`;
  }

  saveCourseState(currentCourseId, state);
  updateSidebarStats();
}

function toggleQuestionStar(courseId, uniqueId, btnEl) {
  const state = loadCourseState(courseId);
  if (state.stars.includes(uniqueId)) {
    state.stars = state.stars.filter((id) => id !== uniqueId);
    btnEl.classList.remove("starred");
  } else {
    state.stars.push(uniqueId);
    btnEl.classList.add("starred");
  }
  saveCourseState(courseId, state);
}

// ============================================================================
// 8. SÜRELİ GOSS DENEME SINAVI MOTORU (40/50 DK, %35 HATA TAKVİYESİ, 70 BARAJ)
// ============================================================================
function renderExamSetup() {
  const course = getCourseById(currentCourseId);
  document.getElementById("examSetupBox").classList.remove("hidden");
  document.getElementById("examActiveBox").classList.add("hidden");
  document.getElementById("examResultBox").classList.add("hidden");

  document.getElementById("examCourseRulesText").textContent =
    `Seçili Ders: ${course.name} | Soru Sayısı: ${course.examQuestionCount} Soru | Süre: ${course.examDurationMinutes} Dakika | Geçme Barajı: ${course.passScore} Puan`;
}

function startTimedExam() {
  const course = getCourseById(currentCourseId);
  const state = loadCourseState(currentCourseId);
  const selectedType = document.querySelector('input[name="examType"]:checked').value;

  // Dersteki tüm soruları topla
  let allCourseQuestions = [];
  course.tests.forEach((t) => {
    t.questions.forEach((q) => {
      allCourseQuestions.push({
        ...q,
        courseId: course.id,
        courseName: course.name,
        testId: t.id,
        testName: t.name,
        uniqueId: `${t.id}_${q.id}`
      });
    });
  });

  if (allCourseQuestions.length === 0) {
    alert("Bu derste henüz soru bulunmuyor. Lütfen önce test ekleyin.");
    return;
  }

  const targetCount = Math.min(course.examQuestionCount, allCourseQuestions.length);
  let chosenQuestions = [];

  if (selectedType === "smart") {
    // %35 Hata Havuzundan + %65 Kalan Havuzdan
    const errorPool = allCourseQuestions.filter((q) => state.status[q.uniqueId] === "wrong");
    shuffleArray(errorPool);
    const maxFromErrors = Math.round(targetCount * 0.35);
    const pickedErrors = errorPool.slice(0, maxFromErrors);
    const pickedIds = new Set(pickedErrors.map((q) => q.uniqueId));

    const remainingPool = allCourseQuestions.filter((q) => !pickedIds.has(q.uniqueId));
    shuffleArray(remainingPool);
    const neededRest = targetCount - pickedErrors.length;

    chosenQuestions = pickedErrors.concat(remainingPool.slice(0, neededRest));
    shuffleArray(chosenQuestions);
  } else {
    const copyPool = [...allCourseQuestions];
    shuffleArray(copyPool);
    chosenQuestions = copyPool.slice(0, targetCount);
  }

  activeExam = {
    questions: chosenQuestions,
    userChoices: {},
    timerInterval: null,
    remainingSeconds: course.examDurationMinutes * 60,
    examType: selectedType
  };

  document.getElementById("examSetupBox").classList.add("hidden");
  document.getElementById("examResultBox").classList.add("hidden");
  document.getElementById("examActiveBox").classList.remove("hidden");

  document.getElementById("examRunningTitle").textContent = `${course.name} Sınavı`;
  updateExamProgressBadge();
  renderExamQuestions(state);
  startExamCountdown();
}

function renderExamQuestions(state) {
  const container = document.getElementById("examQuestionsContainer");
  container.innerHTML = "";

  activeExam.questions.forEach((q, idx) => {
    const card = document.createElement("div");
    card.className = "question-card";
    const isStarred = state.stars.includes(q.uniqueId);

    card.innerHTML = `
      <div class="q-meta-bar">
        <div class="q-badges">
          <span class="source-badge">Sınav Sorusu ${idx + 1} • [Kaynak: ${q.testName} - Soru ${q.id}]</span>
        </div>
        <div class="q-actions">
          <button class="edit-q-btn" title="Soruyu Düzenle">✏️ Düzenle</button>
          <button class="star-btn ${isStarred ? "starred" : ""}" title="Yıldızla">★</button>
        </div>
      </div>
      <div class="q-body-text">${escapeHTML(q.soru)}</div>
      <div class="options-group">
        ${q.secenekler.map((optStr) => {
          const letter = optStr.trim().charAt(0).toUpperCase();
          return `<button class="option-btn" data-letter="${letter}">${escapeHTML(optStr)}</button>`;
        }).join("")}
      </div>
    `;

    const optBtns = card.querySelectorAll(".option-btn");
    optBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        optBtns.forEach((b) => b.classList.remove("selected-exam"));
        btn.classList.add("selected-exam");
        activeExam.userChoices[q.uniqueId] = btn.getAttribute("data-letter");
        updateExamProgressBadge();
      });
    });

    card.querySelector(".star-btn").addEventListener("click", (e) => {
      toggleQuestionStar(q.courseId, q.uniqueId, e.currentTarget);
    });

    card.querySelector(".edit-q-btn").addEventListener("click", () => {
      openEditQuestionModal(q);
    });

    container.appendChild(card);
  });
}

function updateExamProgressBadge() {
  const answered = Object.keys(activeExam.userChoices).length;
  const total = activeExam.questions.length;
  document.getElementById("examAnsweredCounter").textContent = `${answered} / ${total} İşaretlendi`;
}

function startExamCountdown() {
  updateTimerDisplay();
  activeExam.timerInterval = setInterval(() => {
    activeExam.remainingSeconds--;
    updateTimerDisplay();
    if (activeExam.remainingSeconds <= 0) {
      clearInterval(activeExam.timerInterval);
      activeExam.timerInterval = null;
      alert("Sınav süresi doldu! Sonuçlarınız hesaplanıyor.");
      finishTimedExam(true);
    }
  }, 1000);
}

function updateTimerDisplay() {
  const mins = Math.floor(activeExam.remainingSeconds / 60);
  const secs = activeExam.remainingSeconds % 60;
  document.getElementById("examTimerDisplay").textContent =
    `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function finishTimedExam(autoFinish) {
  if (!autoFinish && !confirm("Sınavı bitirip sonuçları görmek istiyor musunuz?")) return;

  if (activeExam.timerInterval) {
    clearInterval(activeExam.timerInterval);
    activeExam.timerInterval = null;
  }

  const course = getCourseById(currentCourseId);
  const state = loadCourseState(currentCourseId);

  let correct = 0;
  let wrong = 0;
  let empty = 0;

  activeExam.questions.forEach((q) => {
    const userChoice = activeExam.userChoices[q.uniqueId];
    if (!userChoice) {
      empty++;
    } else if (userChoice === q.dogru) {
      correct++;
      state.answers[q.uniqueId] = userChoice;
      if (state.status[q.uniqueId] !== "wrong") {
        state.status[q.uniqueId] = "correct";
      }
    } else {
      wrong++;
      state.answers[q.uniqueId] = userChoice;
      state.status[q.uniqueId] = "wrong";
      const prevDebt = state.errorCounts[q.uniqueId] || 0;
      state.errorCounts[q.uniqueId] = Math.min(5, prevDebt + 1);
    }
  });

  saveCourseState(currentCourseId, state);
  updateSidebarStats();

  const totalQ = activeExam.questions.length;
  const score = Math.round((correct / totalQ) * 100);
  const passed = score >= course.passScore;

  // Sınav Geçmişine Kaydet
  const history = loadExamHistory();
  history.push({
    date: new Date().toLocaleString("tr-TR"),
    courseName: course.name,
    examType: activeExam.examType,
    correct,
    wrong,
    empty,
    score,
    passed
  });
  saveExamHistory(history);

  // Sonuç Raporunu Göster
  document.getElementById("examActiveBox").classList.add("hidden");
  const resBox = document.getElementById("examResultBox");
  resBox.classList.remove("hidden");

  resBox.innerHTML = `
    <h2>Sınav Sonucu: <span class="${passed ? "pass-tag" : "fail-tag"}">${score} PUAN — ${passed ? "BAŞARILI (GEÇTİ)" : "BAŞARISIZ (KALDI)"}</span></h2>
    <p class="muted-text" style="margin:8px 0 18px;">
      Doğru: <strong>${correct}</strong> | Yanlış: <strong>${wrong}</strong> | Boş: <strong>${empty}</strong> (Baraj: ${course.passScore})
      <br>Bu sınavda yanlış yaptığın ${wrong} soru otomatik olarak <strong>${course.name} Hata Havuzuna</strong> eklendi.
    </p>
    <button id="newExamBtn" class="btn-primary">Yeni Sınav Kurulumuna Dön</button>
  `;

  document.getElementById("newExamBtn").addEventListener("click", renderExamSetup);
}

// ============================================================================
// 9. MODÜLER SIFIRLAMA MOTORU
// ============================================================================
function resetByCategory(targetStatus) {
  const labelMap = {
    wrong: "SADECE HATALI SORULAR (Doğrular ve Cevabı Gösterilenler korunacak)",
    revealed: "SADECE CEVABI GÖSTERİLENLER (Doğrular ve Hatalar korunacak)",
    correct: "SADECE DOĞRU ÇÖZÜLENLER (Hatalar ve Gösterilenler korunacak)"
  };

  if (!confirm(`Bu dersteki ${labelMap[targetStatus]} sıfırlansın mı?`)) return;

  const state = loadCourseState(currentCourseId);
  Object.keys(state.status).forEach((uid) => {
    if (state.status[uid] === targetStatus) {
      delete state.status[uid];
      delete state.answers[uid];
      if (targetStatus === "wrong") {
        delete state.errorCounts[uid];
      }
    }
  });

  saveCourseState(currentCourseId, state);
  refreshActiveScreen();
}

function resetActiveTestOnly() {
  if (currentTestId === "ALL_COMBINED") {
    alert("Lütfen önce sol menüden sıfırlamak istediğiniz tekil testi seçin.");
    return;
  }
  if (!confirm(`Sadece seçili testin (${currentTestId}) işaretleri sıfırlansın mı?`)) return;

  const state = loadCourseState(currentCourseId);
  const prefix = `${currentTestId}_`;

  Object.keys(state.status).forEach((uid) => {
    if (uid.startsWith(prefix)) {
      delete state.status[uid];
      delete state.answers[uid];
      delete state.errorCounts[uid];
    }
  });

  saveCourseState(currentCourseId, state);
  refreshActiveScreen();
}

function resetEntireCourse() {
  const course = getCourseById(currentCourseId);
  if (!confirm(`DİKKAT: "${course.name}" dersine ait tüm doğrular, hatalar, incelenenler ve yıldızlar tamamen sıfırlanacak. Emin misiniz?`)) return;
  localStorage.removeItem(getCourseStateKey(currentCourseId));
  pushToCloud(); // Sınav bittiğinde sonucu buluta yedekler
  refreshActiveScreen();
}

// ============================================================================
// 10. UYGULAMA İÇİNDEN JSON TEST EKLEME VE SİLME
// ============================================================================
function openUploadModal() {
  document.getElementById("uploadCourseSelect").value = currentCourseId;
  document.getElementById("uploadTestName").value = "";
  document.getElementById("uploadJsonFile").value = "";
  document.getElementById("uploadJsonTextarea").value = "";
  document.getElementById("uploadModal").classList.remove("hidden");
}

function closeUploadModal() {
  document.getElementById("uploadModal").classList.add("hidden");
}

async function handleAddNewTest() {
  const targetCourseId = document.getElementById("uploadCourseSelect").value;
  const testNameInput = document.getElementById("uploadTestName").value.trim();
  const fileInput = document.getElementById("uploadJsonFile");
  const rawTextarea = document.getElementById("uploadJsonTextarea").value.trim();

  if (!testNameInput) {
    alert("Lütfen teste bir isim verin (Örn: Test 2 veya Çıkmış Sorular).");
    return;
  }

  let jsonText = rawTextarea;
  if (fileInput.files && fileInput.files.length > 0) {
    jsonText = await fileInput.files[0].text();
  }

  if (!jsonText) {
    alert("Lütfen bir .json dosyası seçin veya JSON içeriğini kutuya yapıştırın.");
    return;
  }

  try {
    const parsedQuestions = JSON.parse(jsonText);
    if (!Array.isArray(parsedQuestions) || parsedQuestions.length === 0) {
      alert("JSON dosyası geçerli bir soru listesi ([ ... ]) içermiyor.");
      return;
    }

    // Soru formatını normalize et
    const normalizedQuestions = parsedQuestions.map((item, idx) => ({
      id: item.id || idx + 1,
      soru: String(item.soru || "").trim(),
      secenekler: Array.isArray(item.secenekler) ? item.secenekler : [],
      dogru: String(item.dogru || item.dogru_cevap || "A").trim().charAt(0).toUpperCase(),
      aciklama: String(item.aciklama || "").trim()
    }));

    const course = getCourseById(targetCourseId);
    const newTestId = `test_${Date.now()}`;

    course.tests.push({
      id: newTestId,
      name: testNameInput,
      questions: normalizedQuestions
    });

    await saveDatabase(appData);
    currentCourseId = targetCourseId;
    document.getElementById("courseSelect").value = currentCourseId;
    populateTestSelector();
    currentTestId = newTestId;
    document.getElementById("testSelect").value = newTestId;

    closeUploadModal();
    refreshActiveScreen();
    alert(`"${testNameInput}" (${normalizedQuestions.length} soru) başarıyla eklendi!`);
  } catch (err) {
    alert("JSON formatı hatalı! Lütfen parantezleri veya dosya yapısını kontrol edin.\nDetay: " + err.message);
  }
}

async function handleDeleteCurrentTest() {
  if (!currentTestId || currentTestId === "ALL_COMBINED") {
    alert("Silmek için lütfen sol menüden tekil bir test seçin.");
    return;
  }

  const course = getCourseById(currentCourseId);
  const testObj = course.tests.find((t) => t.id === currentTestId);
  if (!testObj) return;

  if (!confirm(`"${testObj.name}" testini (${testObj.questions.length} soru) silmek istediğinize emin misiniz?`)) return;

  course.tests = course.tests.filter((t) => t.id !== currentTestId);
  await saveDatabase(appData);

  populateTestSelector();
  refreshActiveScreen();
}

// ============================================================================
// 11. UYGULAMA İÇİ CANLI SORU DÜZENLEME (İSTATİSTİKLERİ SIFIRLAMADAN)
// ============================================================================
function openEditQuestionModal(q) {
  editingTarget = {
    courseId: q.courseId,
    testId: q.testId,
    questionId: q.id,
    uniqueId: q.uniqueId
  };

  document.getElementById("editModalTitle").textContent =
    `✏️ Düzenle: ${q.testName} • Soru ${q.id}`;
  document.getElementById("editQText").value = q.soru;

  // Şıkları A, B, C, D, E kutularına yerleştir
  const optInputs = ["editOptA", "editOptB", "editOptC", "editOptD", "editOptE"];
  optInputs.forEach((inputId) => (document.getElementById(inputId).value = ""));

  q.secenekler.forEach((optStr, i) => {
    if (i < 5) {
      const cleaned = optStr.replace(/^[A-Ea-e]\)\s*/, "").trim();
      document.getElementById(optInputs[i]).value = cleaned;
    }
  });

  document.getElementById("editCorrectOpt").value = q.dogru;
  document.getElementById("editExplanation").value = q.aciklama || "";

  document.getElementById("editQuestionModal").classList.remove("hidden");
}

function closeEditModal() {
  document.getElementById("editQuestionModal").classList.add("hidden");
  editingTarget = null;
}

async function handleSaveEditedQuestion() {
  if (!editingTarget) return;

  const newQText = document.getElementById("editQText").value.trim();
  const optA = document.getElementById("editOptA").value.trim();
  const optB = document.getElementById("editOptB").value.trim();
  const optC = document.getElementById("editOptC").value.trim();
  const optD = document.getElementById("editOptD").value.trim();
  const optE = document.getElementById("editOptE").value.trim();
  const newCorrect = document.getElementById("editCorrectOpt").value;
  const newExp = document.getElementById("editExplanation").value.trim();

  if (!newQText || !optA || !optB) {
    alert("Soru metni ve en az A, B şıkları dolu olmalıdır.");
    return;
  }

  const updatedOptions = [
    `A) ${optA}`,
    `B) ${optB}`,
    `C) ${optC}`,
    `D) ${optD}`
  ];
  if (optE) {
    updatedOptions.push(`E) ${optE}`);
  }

  // Ana veritabanında soruyu bul ve yerinde güncelle (uniqueId asla değişmez!)
  const course = getCourseById(editingTarget.courseId);
  const testObj = course.tests.find((t) => t.id === editingTarget.testId);
  const qItem = testObj.questions.find((item) => item.id === editingTarget.questionId);

  if (qItem) {
    qItem.soru = newQText;
    qItem.secenekler = updatedOptions;
    qItem.dogru = newCorrect;
    qItem.aciklama = newExp;
    await saveDatabase(appData);
  }

  // Eğer aktif bir deneme sınavının içindeysek oradaki kopyayı da güncelle
  if (currentMode === "exam" && activeExam.questions.length > 0) {
    const examQ = activeExam.questions.find((eq) => eq.uniqueId === editingTarget.uniqueId);
    if (examQ) {
      examQ.soru = newQText;
      examQ.secenekler = updatedOptions;
      examQ.dogru = newCorrect;
      examQ.aciklama = newExp;
    }
    const state = loadCourseState(currentCourseId);
    renderExamQuestions(state);
  } else {
    refreshActiveScreen();
  }

  closeEditModal();
}

// ============================================================================
// 12. VERİTABANI VE TEST DIŞA AKTARMA (ARKADAŞLA PAYLAŞIM & YEDEK)
// ============================================================================
function exportDatabaseJS() {
  const content = "window.INITIAL_DATABASE = " + JSON.stringify(appData, null, 2) + ";\n";
  const blob = new Blob([content], { type: "application/javascript;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "database.js";
  a.click();
  URL.revokeObjectURL(url);
}

function exportSelectedTestJSON() {
  if (!currentTestId || currentTestId === "ALL_COMBINED") {
    alert("İndirmek için lütfen sol menüden tekil bir test seçin.");
    return;
  }
  const course = getCourseById(currentCourseId);
  const testObj = course.tests.find((t) => t.id === currentTestId);
  if (!testObj) return;

  const content = JSON.stringify(testObj.questions, null, 2);
  const blob = new Blob([content], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${course.id}_${testObj.id}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ============================================================================
// YARDIMCI FONKSİYONLAR
// ============================================================================
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
// ============================================================================
// 13. BULUT SENKRONİZASYON MOTORU (CİHAZLAR ARASI OTOMATİK EŞİTLEME)
// ============================================================================
// DİKKAT: Aşağıdaki tırnak içine kendi Firebase Realtime Database linkini yapıştır (sonunda / olmasın)
const FIREBASE_URL = "https://goss-sinav-bulut-default-rtdb.firebaseio.com/";

function getOrCreateSyncCode() {
  let code = localStorage.getItem("goss_sync_code");
  if (!code) {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let randomPart = "";
    for (let i = 0; i < 4; i++) {
      randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    code = `GOSS-${randomPart}`;
    localStorage.setItem("goss_sync_code", code);
  }
  return code;
}

async function initCloudSync() {
  const code = getOrCreateSyncCode();
  const displayEl = document.getElementById("syncCodeDisplay");
  if (displayEl) displayEl.textContent = code;

  const syncBtn = document.getElementById("cloudSyncBtn");
  if (syncBtn) {
    syncBtn.addEventListener("click", async () => {
      const currentCode = getOrCreateSyncCode();
      const input = prompt(
        `Sizin Cihaz Eşleme Kodunuz: ${currentCode}\n\n` +
        `Başka bir cihazdaki (Telefon/PC) ilerlemenizi buraya aktarmak için o cihazdaki kodu aşağıya yazın:`,
        currentCode
      );

      if (!input) return;
      const cleanCode = input.trim().toUpperCase();
      if (cleanCode === currentCode) {
        await pullFromCloud(currentCode, true);
      } else {
        localStorage.setItem("goss_sync_code", cleanCode);
        if (displayEl) displayEl.textContent = cleanCode;
        await pullFromCloud(cleanCode, true);
      }
    });
  }

  // Sayfa açıldığında buluttaki güncel veriyi sessizce çek
  await pullFromCloud(code, false);
}

async function pushToCloud() {
  if (!FIREBASE_URL || FIREBASE_URL.includes("SENIN-PROJEN")) return;
  const code = getOrCreateSyncCode();

  const payload = {
    updatedAt: Date.now(),
    examHistory: loadExamHistory(),
    coursesState: {}
  };

  if (appData && appData.courses) {
    appData.courses.forEach((c) => {
      payload.coursesState[c.id] = loadCourseState(c.id);
    });
  }

  try {
    await fetch(`${FIREBASE_URL}/users/${code}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.warn("Buluta yedeklenemedi (Çevrimdışı olabilirsiniz):", err);
  }
}

async function pullFromCloud(code, showNotification = false) {
  if (!FIREBASE_URL || FIREBASE_URL.includes("SENIN-PROJEN")) return;

  try {
    const res = await fetch(`${FIREBASE_URL}/users/${code}.json`);
    if (!res.ok) return;
    const cloudData = await res.json();

    if (cloudData) {
      if (cloudData.coursesState) {
        Object.keys(cloudData.coursesState).forEach((courseId) => {
          localStorage.setItem(
            getCourseStateKey(courseId),
            JSON.stringify(cloudData.coursesState[courseId])
          );
        });
      }
      if (cloudData.examHistory) {
        localStorage.setItem("goss_exam_history_v2", JSON.stringify(cloudData.examHistory));
      }
      if (showNotification) {
        refreshActiveScreen();
        alert(`"${code}" kodlu profilin tüm soru ve hata havuzu verileri başarıyla senkronize edildi!`);
      }
    } else if (showNotification) {
      // Bulutta henüz veri yoksa mevcut cihazın verisini buluta gönder
      await pushToCloud();
      alert(`"${code}" kodu buluta tanımlandı. Artık diğer cihazlarınızdan bu kodu girerek eşitlenebilirsiniz.`);
    }
  } catch (err) {
    if (showNotification) alert("İnternet bağlantısı kurulamadı.");
  }
}