// CPF/CNPJ com digito verificador (F3). Os documentos sao gravados apenas com digitos.
function onlyDigits(value) {
	return String(value ?? "").replace(/\D/g, "");
}

function isValidCpf(digits) {
	if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
	for (const length of [9, 10]) {
		let sum = 0;
		for (let index = 0; index < length; index += 1) sum += Number(digits[index]) * (length + 1 - index);
		const check = ((sum * 10) % 11) % 10;
		if (check !== Number(digits[length])) return false;
	}
	return true;
}

function isValidCnpj(digits) {
	if (!/^\d{14}$/.test(digits) || /^(\d)\1{13}$/.test(digits)) return false;
	for (const length of [12, 13]) {
		const weights = length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
		let sum = 0;
		for (let index = 0; index < length; index += 1) sum += Number(digits[index]) * weights[index];
		const rest = sum % 11;
		const check = rest < 2 ? 0 : 11 - rest;
		if (check !== Number(digits[length])) return false;
	}
	return true;
}

function isValidDocument(value) {
	const digits = onlyDigits(value);
	return isValidCpf(digits) || isValidCnpj(digits);
}

function formatDocument(value) {
	const digits = onlyDigits(value);
	if (digits.length === 11) return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
	if (digits.length === 14) return digits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
	return String(value ?? "");
}

module.exports = { onlyDigits, isValidCpf, isValidCnpj, isValidDocument, formatDocument };
