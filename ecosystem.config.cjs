module.exports = {
    apps: [
        {
            name: 'area-coach-tools',
            script: 'src/app.js',
            instances: 1,
            exec_mode: 'fork',
            max_memory_restart: '1G',
            env: { NODE_ENV: 'production' },
        },
        {
            name: 'forecast-scheduler',
            script: 'scripts/run-forecast-scheduler.js',
            instances: 1,
            exec_mode: 'fork',
            env: { NODE_ENV: 'production' },
        },
    ],
};
