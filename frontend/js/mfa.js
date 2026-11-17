// Ativacao da verificacao em duas etapas (TOTP), usada na tela inicial (quando o MFA e obrigatorio) e em
// Minha conta. Passos: confirmar a senha -> ler o QR Code no aplicativo -> digitar o codigo -> guardar os
// codigos de recuperacao.
(() => {
	const PP = window.PP;
	if (!PP || PP.mfaEnrollment) return;
	const { esc, api } = PP;

	function downloadText(fileName, text) {
		const link = document.createElement("a");
		link.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
		link.download = fileName;
		document.body.appendChild(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(link.href), 10000);
	}

	function showRecoveryCodes(container, codes, onDone, doneLabel = "Já guardei os códigos") {
		const text = `Plano Pneumatic - códigos de recuperação da verificação em duas etapas\nCada código vale uma única vez.\n\n${codes.join("\n")}\n`;
		container.innerHTML = `<div class="mfa-step"><p><strong>Guarde estes códigos de recuperação.</strong> Se perder o celular, cada código permite entrar uma única vez. Eles não serão mostrados de novo.</p><ol class="recovery-codes">${codes.map((code) => `<li><code>${esc(code)}</code></li>`).join("")}</ol><div class="form-actions"><button class="button button-secondary" type="button" data-copy>Copiar</button><button class="button button-secondary" type="button" data-download>Baixar .txt</button><button class="button button-primary" type="button" data-done>${esc(doneLabel)}</button></div></div>`;
		container.querySelector("[data-copy]").addEventListener("click", async () => {
			try {
				await navigator.clipboard.writeText(text);
				PP.toast("Códigos copiados.", "success");
			} catch {
				PP.toast("Não foi possível copiar. Use o botão Baixar.", "error");
			}
		});
		container.querySelector("[data-download]").addEventListener("click", () => downloadText("plano-pneumatic-codigos-de-recuperacao.txt", text));
		container.querySelector("[data-done]").addEventListener("click", () => onDone?.());
		container.querySelector("[data-done]").focus();
	}

	function mfaEnrollment(container, { onDone, onCancel } = {}) {
		container.innerHTML = `<form class="form mfa-step" data-step="password" novalidate><p>Use um aplicativo autenticador no celular (Google Authenticator, Microsoft Authenticator, Authy ou 1Password). Para começar, confirme sua senha.</p><label>Senha<input name="password" type="password" autocomplete="current-password" required /></label><div class="form-actions">${onCancel ? '<button class="button button-secondary" type="button" data-cancel>Cancelar</button>' : ""}<button class="button button-primary" type="submit">Continuar</button></div><p class="feedback" role="alert"></p></form>`;
		container.querySelector("[data-cancel]")?.addEventListener("click", () => onCancel());
		const passwordForm = container.querySelector("form");
		passwordForm.password.focus();
		passwordForm.addEventListener("submit", async (event) => {
			event.preventDefault();
			const feedback = passwordForm.querySelector(".feedback");
			feedback.textContent = "";
			try {
				const setup = await api.post("/api/auth/mfa/setup", { password: passwordForm.password.value });
				container.innerHTML = `<form class="form mfa-step" data-step="code" novalidate><p>1. No aplicativo, toque em <strong>adicionar conta</strong> e leia o QR Code.</p><img class="mfa-qr" src="${esc(setup.qrDataUrl)}" alt="QR Code para cadastrar o Plano Pneumatic no aplicativo autenticador" width="200" height="200" /><details><summary>Não consigo ler o QR Code</summary><p class="muted">Digite esta chave no aplicativo (tipo: baseada em tempo):</p><code class="mfa-secret">${esc(setup.secret.replace(/(.{4})/g, "$1 ").trim())}</code></details><p>2. Digite o código de 6 dígitos que aparece no aplicativo.</p><label>Código de verificação<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required /></label><div class="form-actions">${onCancel ? '<button class="button button-secondary" type="button" data-cancel>Cancelar</button>' : ""}<button class="button button-primary" type="submit">Ativar</button></div><p class="feedback" role="alert"></p></form>`;
				container.querySelector("[data-cancel]")?.addEventListener("click", () => onCancel());
				const codeForm = container.querySelector("form");
				codeForm.code.focus();
				codeForm.addEventListener("submit", async (submit) => {
					submit.preventDefault();
					const codeFeedback = codeForm.querySelector(".feedback");
					codeFeedback.textContent = "";
					try {
						const result = await api.post("/api/auth/mfa/enable", { code: codeForm.code.value.trim() });
						showRecoveryCodes(container, result.recoveryCodes, onDone);
					} catch (error) {
						codeFeedback.textContent = error.message;
						codeForm.code.select();
					}
				});
			} catch (error) {
				feedback.textContent = error.message;
			}
		});
	}

	PP.mfaEnrollment = mfaEnrollment;
	PP.showRecoveryCodes = showRecoveryCodes;
})();
