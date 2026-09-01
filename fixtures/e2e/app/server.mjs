import { createServer } from 'node:http';

const host = '127.0.0.1';
const port = 4173;

const server = createServer((_request, response) => {
	response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
	response.end('<main><h1>MiKode CI fixture</h1></main>');
});

server.listen(port, host);

const shutdown = () => {
	server.close(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
