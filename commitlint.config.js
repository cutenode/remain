// Commit subjects follow Conventional Commits, `type(scope): summary`.
export default {
	extends: ['@commitlint/config-conventional'],
	rules: {
		'header-max-length': [0],
		'body-max-line-length': [0],
	},
};
