import http from 'node:http';

const port = Number(process.argv[2] || 8799);
const t0 = Date.now();
const srv = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, status: 'ok', uptime_s: Math.round((Date.now() - t0) / 1000) }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false }));
});
srv.listen(port, '127.0.0.1', () => {
  console.log('standin listening on ' + port);
});
