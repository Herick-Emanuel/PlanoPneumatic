const { roles } = require("./constants");

const capabilities = Object.freeze({
	VIEW_USERS: "users.view",
	CREATE_OPERATOR: "users.create.operator",
	CREATE_MANAGER: "users.create.manager",
	CREATE_ANY_ROLE: "users.create.any",
	EDIT_USER: "users.edit",
	MANAGE_USER_STATUS: "users.status.manage",
	TRANSFER_TEAM: "users.team.transfer",
	VIEW_AUDIT: "users.audit.view",
	ASSIGN_CASES: "cases.assign",
	CREATE_CASE: "cases.create",
	EDIT_CASE: "cases.edit",
	DECIDE_CASE: "cases.decide",
	TECHNICAL_ANALYSIS: "cases.technical",
	MANAGE_LOGISTICS: "cases.logistics",
	REOPEN_CASE: "cases.reopen",
	ARCHIVE_CASE: "cases.archive",
	IMPORT_CASES: "cases.import",
	VIEW_ALL_CASES: "cases.view.all",
	MANAGE_REGISTRY: "registry.manage",
	MANAGE_SETTINGS: "settings.manage",
	MANAGE_INTEGRATIONS: "integrations.manage",
	VIEW_TEAM_REPORTS: "reports.team.view",
	VIEW_MANAGER_PERFORMANCE: "reports.managers.view",
	EXPORT_REPORTS: "reports.export"
});

const c = capabilities;
const everyone = [c.CREATE_CASE, c.EDIT_CASE, c.EXPORT_REPORTS];

const permissionMatrix = Object.freeze({
	[roles.ADMIN]: Object.values(c),
	[roles.MANAGER]: [
		c.VIEW_USERS, c.CREATE_OPERATOR, c.MANAGE_USER_STATUS, c.VIEW_AUDIT, c.ASSIGN_CASES, c.VIEW_TEAM_REPORTS,
		c.EDIT_USER, c.DECIDE_CASE, c.TECHNICAL_ANALYSIS, c.MANAGE_LOGISTICS, c.REOPEN_CASE, c.ARCHIVE_CASE,
		c.IMPORT_CASES, c.VIEW_ALL_CASES, c.MANAGE_REGISTRY, c.MANAGE_SETTINGS, ...everyone
	],
	[roles.SUPERVISOR]: [c.ASSIGN_CASES, c.IMPORT_CASES, c.VIEW_ALL_CASES, c.MANAGE_REGISTRY, ...everyone],
	[roles.OPERATOR]: [...everyone],
	[roles.TECHNICIAN]: [c.DECIDE_CASE, c.TECHNICAL_ANALYSIS, c.VIEW_ALL_CASES, ...everyone],
	[roles.LOGISTICS]: [c.MANAGE_LOGISTICS, c.VIEW_ALL_CASES, ...everyone],
	[roles.AUDITOR]: [c.VIEW_ALL_CASES, c.VIEW_AUDIT, c.EXPORT_REPORTS]
});

function can(user, capability) {
	return permissionMatrix[user?.role]?.includes(capability) || false;
}

function hasRole(user, allowedRoles) {
	return allowedRoles.includes(user?.role);
}

module.exports = { capabilities, permissionMatrix, can, hasRole };
