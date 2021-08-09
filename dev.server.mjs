import http2        from 'http2';
import fs           from 'fs';
import {gzip}       from 'zlib';
import config       from './server.config.mjs';
import indexBuilder from './index.compiler.mjs';
import mimes        from './util.mimes.mjs';
import Cache        from './util.cache.mjs';
import {Registrar}  from './util.ipc.mjs';

const cache     = new Cache();
const registrar = new Registrar(config.dirs.server + '/sockets/registrar.sock');
const nothing   = () => null;
const server    = http2.createSecureServer({
    cert: fs.readFileSync(config.dirs.server + '/cert.pem'),
    key : fs.readFileSync(config.dirs.server + '/key.pem')
});
const errors    = {
    api: JSON.stringify({
        status: 'error'
    }),
}

void server.on('error',  console.error);
void server.on('stream', router);

void server.listen(8080);


function checkFile  (path) {
    return new Promise(resolve => {
        void fs.access(path, err => void resolve(err ? false : true));
    });
}
function getHeaders (meta, zip, cache) {
    let cachetime = meta.query.nocache || cache === 0
        ? '0'
        : cache ? cache : 30;

    return {
        ":status"          : 200,
        "content-type"     : meta.mime,
        "content-encoding" : zip ? 'gzip' : '',
        "cache-control"    : 'max-age=' + cachetime,
        "last-modified"    : 'Fri, 29 Nov 1974 12:26:08 GMT',
    };
}
function getMeta    (stream, headers) {
    const url           = headers[':path'];
    const [path, query] = (url || '').split('?');
    const ext           = path.split('.').pop();
    const meta          = {
        path, ext,
        isApiApp   : path.startsWith('/api/app/'),
        isApiUser  : path.startsWith('/api/v1/'),
        isApiAdmin : path.startsWith('/api/admin/'),
        isAdmin    : path.startsWith('/_admin_/'),
        isFile     : path.includes('.'),
        isIndex    : path.endsWith('/'),
        query      : query ? getQuery(query) : {},
        ip         : stream.session.socket.remoteAddress,
    };

    meta.mime     = meta.isIndex ? mimes.html : mimes[ext] || mimes.txt;
    meta.file     = meta.isFile  ? config.dirs.public + path : '';
    meta.zippable = mimes._canZip(meta.mime);
    meta.redirect = (
        !meta.isIndex     && 
        !meta.isFile      && 
        !meta.isAdmin     && 
        !meta.isApiApp    &&
        !meta.isApiAdmin  &&
        !meta.isApiUser 
            ? `https://${headers[':authority'] + path}/${query ? ('?' + query) : ''}` 
            : null
    );

    return meta;
}
function getQuery   (url) {
    const query  = {};

    if (url.includes('=')) {
        void url.split('&').forEach(subject => {
            const [property, value] = subject.split('=');

            query[property] = value;

            return;
        });
    }

    return query;
}
function readFile   (file, raw) {
    return new Promise(resolve => {
        void fs.readFile(file, (err, content) => {
            return void resolve(err ? false : raw ? content : content.toString())
        });
    });
}
function setHeaders (stream, meta, zip, cache) {
    return void stream.respond(getHeaders(meta, zip, cache));
}
function zip        (data) {
    return new Promise(resolve => {
        void gzip(data, (err, content) => void resolve(err ? false : content));
    });
}


async function router         (stream, headers) {
    const meta = getMeta(stream, headers);

    return void (
        meta.redirect   ? sendRedirect   (stream, meta) : 
        meta.isApiUser  ? handleApiUser  (stream, meta) : 
        meta.isApiApp   ? handleApiApp   (stream, meta) : 
        meta.isApiAdmin ? handleApiAdmin (stream, meta) : 
        meta.isAdmin    ? sendAdmin      (stream, meta) : 
        meta.isFile     ? sendCache      (stream, meta) :
        meta.isIndex    ? sendIndex      (stream, meta) : sendError(stream)
    );
}
async function handleApiAdmin (stream, meta) {}
async function handleApiApp   (stream, meta) {
    const response = await registrar.query('api.frontend', meta.query, 1e4);

    void stream.respond({
        "content-type": mimes.json
    });
    void stream.end(response || errors.api);
}
async function handleApiUser  (stream, meta) {}
async function sendAdmin      (stream, meta) {}
async function sendCache      (stream, meta) {
    if (!cache.has(meta.path) || meta.query.nocache) {
        return sendFile(stream, meta);
    }

    const entry = cache.get(meta.path);

    void setHeaders(stream, meta, entry.zip, 300);
    void stream.end(entry.data);

    return;
}
async function sendError      (stream) {
    return void stream.respond(
        { ":status": 404 }, 
        { endStream: true }
    );
}
async function sendIndex      (stream, meta) {
    void setHeaders(stream, meta, true);
    void stream.end(indexBuilder.page || await indexBuilder.render());

    return;
}
async function sendFile       (stream, meta) {
    const file = await fs.promises.open(meta.file).catch(nothing);

    if (!file) {
        return void sendError(stream);
    }

    const size    = (await file.stat()).size;
    const buff    = Buffer.alloc(size);
    const content = await file.read(buff, 0, size, 0);

    if (!content.bytesRead) {
        return void sendError(stream);
    }

    void file.close();

    const zcontent = meta.zippable ? await zip(buff) : null;

    void cache.set({
        key    : meta.path, 
        value  : zcontent || buff, 
        zipped : meta.zippable,
        file   : meta.file
    });
    void setHeaders(stream, meta, meta.zippable);
    void stream.end(zcontent || buff);
}
async function sendRedirect   (stream, meta) {
    return void stream.respond({
        ":status"  : 302,
        "location" : meta.redirect
    }, {endStream: true});
}