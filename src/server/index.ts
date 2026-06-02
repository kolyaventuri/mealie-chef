import process from 'node:process';
import {loadConfig} from './config';
import {createApp} from './routes';

const start = async (): Promise<void> => {
	const config = loadConfig();
	const app = await createApp({config});

	await app.listen({
		host: '0.0.0.0',
		port: config.port,
	});
};

start().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
