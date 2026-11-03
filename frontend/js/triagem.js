const sharedShellScript = document.createElement("script");
sharedShellScript.src = "/js/shared-shell.js";
document.head.appendChild(sharedShellScript);

const PP = window.PP;
const form = document.querySelector("#triage-form");
const feedback = document.querySelector("#triage-feedback");
const nextButton = document.querySelector("#triage-next");
const backButton = document.querySelector("#triage-back");
const submitButton = document.querySelector("#triage-submit");
const draftKey = "pp-draft:triagem";
let currentStage = 1;

function updateSummary() {
  const type = form.type.value;
  document.querySelector("#summary-type").textContent = type || "Tipo não definido";
  document.querySelector("#summary-client").textContent = form.client.value || "Aguardando preenchimento";
  document.querySelector("#summary-product").textContent = form.product.value || "Aguardando preenchimento";
  document.querySelector("#summary-code").textContent = form.productCode.value || "Aguardando preenchimento";
  document.querySelector("#summary-quantity").textContent = `${form.quantity.value || 1} unidade${Number(form.quantity.value) === 1 ? "" : "s"}`;
  document.querySelector("#summary-stage").textContent = currentStage === 1 ? "Triagem em andamento" : currentStage === 2 ? "Validação em andamento" : "Pronto para encaminhar";
  document.querySelector("#summary-next-text").textContent = currentStage === 1 ? "Confirme os dados básicos para validar o cadastro." : currentStage === 2 ? "Confira cliente e produto antes de continuar." : "Salve o cadastro para encaminhar à área responsável.";
}

function setStage(stage) {
  currentStage = stage;
  document.querySelectorAll("[data-triage-stage]").forEach((section) => {
    const visible = Number(section.dataset.triageStage) === stage;
    section.classList.toggle("hidden", !visible);
    section.querySelectorAll("input, select, textarea").forEach((field) => { field.disabled = field.name !== "type" && !visible; });
  });
  document.querySelectorAll("[data-flow-step]").forEach((step) => step.classList.toggle("active", Number(step.dataset.flowStep) === stage));
  backButton.classList.toggle("hidden", stage === 1);
  nextButton.classList.toggle("hidden", stage === 3);
  submitButton.classList.toggle("hidden", stage !== 3);
  document.querySelector(".triage-content .topbar .eyebrow").textContent = `Etapa ${stage} · ${stage === 1 ? "Entrada do processo" : stage === 2 ? "Conferência dos dados" : "Encaminhamento"}`;
  updateSummary();
}

function validateStage() {
  PP.clearFieldErrors(form);
  const fields = [...document.querySelectorAll(`[data-triage-stage="${currentStage}"] input, [data-triage-stage="${currentStage}"] select, [data-triage-stage="${currentStage}"] textarea`)];
  let valid = true;
  for (const field of fields) {
    if (field.disabled) continue;
    if (field.name === "type") continue;
    if (field.required && !String(field.value).trim()) { PP.setFieldError(field, "Campo obrigatório."); valid = false; }
    else if (field.name === "clientDocument" && field.value && !PP.isValidDocument(field.value)) { PP.setFieldError(field, "CPF ou CNPJ inválido."); valid = false; }
    else if (field.name === "quantity" && (!Number.isInteger(Number(field.value)) || Number(field.value) < 1)) { PP.setFieldError(field, "Informe uma quantidade válida."); valid = false; }
  }
  if (currentStage === 1 && !form.type.value) { feedback.textContent = "Selecione o tipo da demanda."; valid = false; }
  if (!valid) (form.querySelector("[aria-invalid]") || form.type)?.focus();
  return valid;
}

function buildPayload() {
  const payload = { intake: true, type: form.type.value, client: form.client.value.trim(), product: form.product.value.trim(), productCode: form.productCode.value.trim(), quantity: Number(form.quantity.value) };
  for (const name of ["clientDocument", "documentReference", "notes"]) if (form[name]?.value.trim()) payload[name] = form[name].value.trim();
  if (form.dataset.customerId) payload.customerId = Number(form.dataset.customerId);
  if (form.dataset.productId) payload.productId = Number(form.dataset.productId);
  return payload;
}

// Rascunho local: nada se perde se a aba fechar ou a conexao cair.
const saveDraft = PP.debounce(() => {
  const values = Object.fromEntries([...form.elements].filter((element) => element.name && element.type !== "radio" || element.checked).map((element) => [element.name, element.value]));
  try { if (values.client || values.product || values.productCode) localStorage.setItem(draftKey, JSON.stringify({ values, stage: currentStage, savedAt: new Date().toISOString() })); } catch { /* armazenamento indisponivel */ }
}, 400);
function offerDraft() {
  let draft;
  try { draft = JSON.parse(localStorage.getItem(draftKey)); } catch { draft = null; }
  if (!draft) return;
  const banner = document.createElement("div");
  banner.className = "draft-banner";
  banner.innerHTML = `<span>Há um rascunho salvo em ${PP.esc(PP.formatDateTime(draft.savedAt))}.</span><span><button type="button" class="button button-secondary compact-button" data-restore>Restaurar</button> <button type="button" class="button button-secondary compact-button" data-discard>Descartar</button></span>`;
  form.before(banner);
  banner.querySelector("[data-restore]").addEventListener("click", () => {
    for (const [name, value] of Object.entries(draft.values)) {
      if (name === "type") { const radio = form.querySelector(`input[name="type"][value="${CSS.escape(value)}"]`); if (radio) radio.checked = true; }
      else if (form.elements[name]) form.elements[name].value = value;
    }
    banner.remove();
    updateSummary();
  });
  banner.querySelector("[data-discard]").addEventListener("click", () => { localStorage.removeItem(draftKey); banner.remove(); });
}

function bindRegistry() {
  const customerList = Object.assign(document.createElement("datalist"), { id: "customer-options" });
  const productList = Object.assign(document.createElement("datalist"), { id: "product-options" });
  document.body.append(customerList, productList);
  let customers = [];
  let products = [];
  form.client.setAttribute("list", "customer-options");
  form.productCode.setAttribute("list", "product-options");
  form.client.addEventListener("input", PP.debounce(async () => {
    if (form.client.value.trim().length < 2) return;
    try { customers = (await PP.api.get(`/api/customers?q=${encodeURIComponent(form.client.value.trim())}&limit=8`)).customers; customerList.innerHTML = customers.map((customer) => `<option value="${PP.esc(customer.name)}">${PP.esc(PP.formatDocument(customer.document || ""))}</option>`).join(""); } catch { /* opcional */ }
  }));
  form.productCode.addEventListener("input", PP.debounce(async () => {
    if (form.productCode.value.trim().length < 2) return;
    try { products = (await PP.api.get(`/api/products?q=${encodeURIComponent(form.productCode.value.trim())}&limit=8`)).products; productList.innerHTML = products.map((product) => `<option value="${PP.esc(product.code)}">${PP.esc(product.description)}</option>`).join(""); } catch { /* opcional */ }
  }));
  form.client.addEventListener("change", () => {
    const match = customers.find((customer) => customer.name === form.client.value);
    if (match?.document && !form.clientDocument.value) form.clientDocument.value = PP.formatDocument(match.document);
    if (match) form.dataset.customerId = match.id; else delete form.dataset.customerId;
    updateSummary();
  });
  form.productCode.addEventListener("change", () => {
    const match = products.find((product) => product.code === form.productCode.value);
    if (match && !form.product.value) form.product.value = match.description;
    if (match) form.dataset.productId = match.id; else delete form.dataset.productId;
    updateSummary();
  });
}

form.addEventListener("input", () => { updateSummary(); saveDraft(); });
nextButton.addEventListener("click", () => { feedback.textContent = ""; if (validateStage()) setStage(currentStage + 1); });
backButton.addEventListener("click", () => { feedback.textContent = ""; setStage(currentStage - 1); });

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  feedback.textContent = "";
  if (!validateStage()) return;
  submitButton.disabled = true;
  try {
    const data = await PP.api.post("/api/cases", buildPayload());
    localStorage.removeItem(draftKey);
    window.location.href = `/caso.html?id=${encodeURIComponent(data.case.id)}&created=1`;
  } catch (error) {
    if (error.status === 0) { PP.outbox.add(buildPayload()); localStorage.removeItem(draftKey); PP.toast("Sem conexão. O processo foi guardado e será enviado quando a internet voltar.", "info"); form.reset(); setStage(1); }
    else if (PP.applyServerErrors(form, error)) feedback.textContent = "Corrija os campos destacados.";
    else feedback.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

setStage(1);
(async () => {
  try {
    const user = await PP.requireUser();
    if (!user) return;
    PP.fillProfile(user);
    PP.bindLogout();
    PP.bindDocumentInput(form.clientDocument);
    bindRegistry();
    offerDraft();
    window.PPShellTools?.mount();
  } catch (error) { feedback.textContent = error.message; }
})();
