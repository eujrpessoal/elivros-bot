module.exports = {
    apps: [{
        name:        'elivros-bot',
        script:      'server.js',
        instances:   1,
        autorestart: true,
        watch:       false,
        max_memory_restart: '1G',
        env: {
            PORT:   3001,
            SECRET: 'TROQUE_ISSO_POR_UMA_SENHA_FORTE',
        },
    }],
};
