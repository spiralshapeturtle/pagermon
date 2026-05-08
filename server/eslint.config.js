const js = require('@eslint/js');

module.exports = [
    js.configs.recommended,
    {
        rules: {
            'no-console': 0,
            'no-unused-expressions': 0,
            'camelcase': 1,
            'no-use-before-define': 0,
            'no-var': 0,
        },
        languageOptions: {
            ecmaVersion: 2020,
            sourceType: 'commonjs',
            globals: {
                require: 'readonly',
                module: 'readonly',
                exports: 'readonly',
                __dirname: 'readonly',
                __filename: 'readonly',
                process: 'readonly',
                console: 'readonly',
                Buffer: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
            }
        }
    }
];
