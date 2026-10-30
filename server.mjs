#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

const SERVER_NAME = 'codearts-req';
const SERVER_VERSION = '1.0.0';
const REQUEST_TIMEOUT_MS = 30000;

const PROJECT_TYPES = ['scrum', 'normal', 'xboard', 'basic', 'phoenix', 'ipd'];
const LIST_PROJECT_TYPES = ['scrum', 'normal', 'xboard'];
const TEMPLATE_IDS = [10001, 10002, 10003];
const QUERY_TYPES = ['domain_projects', 'absent'];

const CREATE_PROJECT_FIELDS = ['project_id', 'project_num_id', 'project_name', 'project_type', 'user_num_id'];

function makeError(error_code, error_msg, extra = {}) {
  const payload = { error: true, error_code, error_msg, ...extra };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

function makeSuccess(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    isError: false,
  };
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmacSHA256Hex(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest('hex');
}

function formatSdkDate(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// 与华为云 SDK 的 urlEncode 保持一致：仅保留 A-Z a-z 0-9 - . _ ~ 与 +
function uriEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%2B/g, '+');
}

function decodeQueryComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sortPairs(pairs) {
  return pairs.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return 0;
  });
}

function buildQueryString(query = {}) {
  const pairs = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) pairs.push([key, String(item)]);
      }
    } else {
      pairs.push([key, String(value)]);
    }
  }
  return sortPairs(pairs)
    .map(([key, value]) => `${uriEncode(key)}=${uriEncode(value)}`)
    .join('&');
}

function canonicalizeQuery(search = '') {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  if (!raw) return '';
  const pairs = [];
  for (const part of raw.split('&')) {
    if (!part) continue;
    const index = part.indexOf('=');
    const rawKey = index === -1 ? part : part.slice(0, index);
    const rawValue = index === -1 ? '' : part.slice(index + 1);
    pairs.push([decodeQueryComponent(rawKey), decodeQueryComponent(rawValue)]);
  }
  return sortPairs(pairs)
    .map(([key, value]) => `${uriEncode(key)}=${uriEncode(value)}`)
    .join('&');
}

function canonicalUri(pathname) {
  const raw = pathname && pathname.length > 0 ? pathname : '/';
  const segments = raw.split('/').map((segment) => uriEncode(decodeQueryComponent(segment)));
  let uri = segments.join('/');
  if (!uri.startsWith('/')) uri = '/' + uri;
  if (!uri.endsWith('/')) uri += '/';
  return uri;
}

function buildSignature({ method, url, ak, sk, body = '', date = new Date() }) {
  const u = new URL(url);
  const xSdkDate = formatSdkDate(date);
  const canonicalURI = canonicalUri(u.pathname);
  const canonicalQueryString = canonicalizeQuery(u.search);

  const signedHeaders = 'host;x-sdk-date';
  const canonicalHeaders = `host:${u.host}\nx-sdk-date:${xSdkDate}\n`;
  const hashedPayload = sha256Hex(body);

  const canonicalRequest = [
    String(method).toUpperCase(),
    canonicalURI,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    hashedPayload,
  ].join('\n');

  const hashedCanonicalRequest = sha256Hex(canonicalRequest);
  const stringToSign = `SDK-HMAC-SHA256\n${xSdkDate}\n${hashedCanonicalRequest}`;
  const signature = hmacSHA256Hex(sk, stringToSign);
  const authorization = `SDK-HMAC-SHA256 Access=${ak}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { authorization, xSdkDate, canonicalRequest, stringToSign };
}

function getConfig() {
  return {
    endpoint: (process.env.CODEARTS_REQ_ENDPOINT || '').trim(),
    ak: (process.env.CODEARTS_REQ_AK || '').trim(),
    sk: (process.env.CODEARTS_REQ_SK || '').trim(),
    proxy: (process.env.CODEARTS_REQ_PROXY || '').trim(),
  };
}

function checkConfig() {
  const { endpoint, ak, sk } = getConfig();
  if (!endpoint) {
    return makeError('MISSING_CONFIG', '缺少环境变量 CODEARTS_REQ_ENDPOINT，请先配置 CodeArts 需求管理终端节点，例如 https://projectman-ext.cn-north-4.myhuaweicloud.com');
  }
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return makeError('MISSING_CONFIG', `环境变量 CODEARTS_REQ_ENDPOINT 格式非法：${endpoint}，必须以 http:// 或 https:// 开头`);
    }
  } catch {
    return makeError('MISSING_CONFIG', `环境变量 CODEARTS_REQ_ENDPOINT 不是合法 URL：${endpoint}`);
  }
  if (!ak) {
    return makeError('MISSING_CONFIG', '缺少环境变量 CODEARTS_REQ_AK，请先配置华为云访问密钥 Access Key Id');
  }
  if (!sk) {
    return makeError('MISSING_CONFIG', '缺少环境变量 CODEARTS_REQ_SK，请先配置华为云访问密钥 Secret Access Key');
  }
  return null;
}

function validateCreateProject(args) {
  const errors = [];
  const { project_name, project_type, description, enterprise_id, source, template_id } = args || {};

  if (typeof project_name !== 'string' || project_name.length < 1 || project_name.length > 128) {
    errors.push('project_name 必填，且为 1-128 字符的字符串');
  }
  if (!PROJECT_TYPES.includes(project_type)) {
    errors.push(`project_type 必填，且为以下之一：${PROJECT_TYPES.join(' / ')}`);
  }
  if (description !== undefined && typeof description !== 'string') {
    errors.push('description 选填，但必须为字符串');
  }
  if (enterprise_id !== undefined && typeof enterprise_id !== 'string') {
    errors.push('enterprise_id 选填，但必须为字符串');
  }
  if (source !== undefined) {
    if (typeof source !== 'string' || source.length > 64) {
      errors.push('source 选填，且为 0-64 字符的字符串');
    }
  }
  if (template_id !== undefined && template_id !== null && template_id !== '') {
    if (!TEMPLATE_IDS.includes(Number(template_id))) {
      errors.push(`template_id 选填，且为以下之一：${TEMPLATE_IDS.join(' / ')}`);
    }
  }
  if (project_type === 'ipd' && (template_id === undefined || template_id === null || template_id === '')) {
    errors.push('当 project_type = ipd 时，template_id 必传');
  }
  return errors;
}

function validateListProjects(args) {
  const errors = [];
  const { offset, limit, search, project_type, sort, archive, query_type } = args || {};

  const off = offset === undefined || offset === null ? 0 : offset;
  const lim = limit === undefined || limit === null ? 10 : limit;

  const offsetValid = Number.isInteger(off) && off >= 0 && off <= 10000;
  const limitValid = Number.isInteger(lim) && lim >= 1 && lim <= 1000;

  if (!offsetValid) {
    errors.push('offset 选填，整数，范围 0-10000，默认 0');
  }
  if (!limitValid) {
    errors.push('limit 选填，整数，范围 1-1000，默认 10');
  }
  if (offsetValid && limitValid && off % lim !== 0) {
    errors.push('offset 必须为 limit 的整数倍');
  }
  if (search !== undefined && typeof search !== 'string') {
    errors.push('search 选填，但必须为字符串');
  }
  if (project_type !== undefined && !LIST_PROJECT_TYPES.includes(project_type)) {
    errors.push(`project_type 选填，且为以下之一：${LIST_PROJECT_TYPES.join(' / ')}`);
  }
  if (sort !== undefined) {
    if (typeof sort !== 'string') {
      errors.push('sort 选填，但必须为字符串，格式 字段:方向，多组用逗号分隔，最多 4 组');
    } else {
      const groups = sort.split(',').map((g) => g.trim()).filter(Boolean);
      if (groups.length > 4) {
        errors.push('sort 最多 4 组');
      } else {
        for (const group of groups) {
          if (!/^[^:]+:(asc|desc)$/i.test(group)) {
            errors.push(`sort 格式非法：「${group}」，应为 字段:asc 或 字段:desc`);
            break;
          }
        }
      }
    }
  }
  if (archive !== undefined && typeof archive !== 'boolean') {
    errors.push('archive 选填，但必须为布尔值');
  }
  if (query_type !== undefined && !QUERY_TYPES.includes(query_type)) {
    errors.push(`query_type 选填，且为以下之一：${QUERY_TYPES.join(' / ')}`);
  }
  return errors;
}

function socks5Connect(proxyHost, proxyPort, targetHost, targetPort, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxyHost, port: proxyPort });
    let phase = 0;
    let buffer = Buffer.alloc(0);
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };

    socket.setTimeout(timeoutMs, () => fail(new Error('SOCKS5 代理连接超时')));
    socket.on('error', fail);
    socket.once('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00])));

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (phase === 0) {
        if (buffer.length < 2) return;
        if (buffer[0] !== 0x05 || buffer[1] !== 0x00) {
          fail(new Error('SOCKS5 代理不接受无需认证的连接'));
          return;
        }
        buffer = buffer.slice(2);
        phase = 1;

        const isIpv4 = net.isIPv4(targetHost);
        let address;
        let atyp;
        if (isIpv4) {
          atyp = 0x01;
          address = Buffer.from(targetHost.split('.').map(Number));
        } else {
          atyp = 0x03;
          const hostBuf = Buffer.from(targetHost, 'utf8');
          address = Buffer.concat([Buffer.from([hostBuf.length]), hostBuf]);
        }
        const portBuf = Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]);
        socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, atyp]), address, portBuf]));
      }

      if (phase === 1) {
        if (buffer.length < 5) return;
        if (buffer[0] !== 0x05 || buffer[1] !== 0x00) {
          fail(new Error(`SOCKS5 连接目标失败，响应码 rep=${buffer[1]}`));
          return;
        }
        const atyp = buffer[3];
        let addressLength;
        if (atyp === 0x01) addressLength = 4;
        else if (atyp === 0x04) addressLength = 16;
        else if (atyp === 0x03) addressLength = 1 + buffer[4];
        else {
          fail(new Error(`SOCKS5 返回了不支持的地址类型 atyp=${atyp}`));
          return;
        }
        const replyLength = 4 + addressLength + 2;
        if (buffer.length < replyLength) return;

        socket.removeListener('data', onData);
        socket.setTimeout(0);
        if (settled) return;
        settled = true;

        const tlsSocket = tls.connect({ socket, servername: targetHost, ALPNProtocols: ['http/1.1'] }, () => {
          tlsSocket.setTimeout(timeoutMs, () => tlsSocket.destroy(new Error('代理请求超时')));
          resolve(tlsSocket);
        });
        tlsSocket.on('error', reject);
      }
    };

    socket.on('data', onData);
  });
}

function decodeChunked(buffer) {
  const chunks = [];
  let position = 0;
  while (position < buffer.length) {
    const lineEnd = buffer.indexOf('\r\n', position);
    if (lineEnd === -1) break;
    const size = parseInt(buffer.slice(position, lineEnd).toString('utf8').split(';')[0], 16);
    if (!Number.isFinite(size) || size <= 0) break;
    position = lineEnd + 2;
    chunks.push(buffer.slice(position, position + size));
    position += size + 2;
  }
  return Buffer.concat(chunks).toString('utf8');
}

function createProxyFetch(proxyUrl) {
  const matched = /^(socks5h?|https?):\/\/(?:[^@/]+@)?([^:/]+):(\d+)\/?$/i.exec(String(proxyUrl).trim());
  if (!matched) {
    throw new Error(`不支持的代理地址：${proxyUrl}，请使用 socks5://主机:端口 或 http://主机:端口 形式`);
  }
  const scheme = matched[1].toLowerCase();
  if (scheme !== 'socks5' && scheme !== 'socks5h') {
    throw new Error(`暂不支持 ${scheme} 代理，请使用 socks5://主机:端口 形式`);
  }
  const proxyHost = matched[2];
  const proxyPort = Number(matched[3]);
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
    throw new Error(`代理端口非法：${matched[3]}`);
  }

  return async (url, init = {}) => {
    const u = new URL(url);
    const targetPort = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    const bodyBuffer = init.body ? Buffer.from(init.body, 'utf8') : Buffer.alloc(0);
    const socket = await socks5Connect(proxyHost, proxyPort, u.hostname, targetPort);

    return new Promise((resolve, reject) => {
      const lines = [`${init.method || 'GET'} ${u.pathname}${u.search} HTTP/1.1`, `Host: ${u.host}`];
      for (const [key, value] of Object.entries(init.headers || {})) {
        lines.push(`${key}: ${value}`);
      }
      lines.push(`Content-Length: ${bodyBuffer.length}`, 'Connection: close', '', '');
      socket.write(lines.join('\r\n'));
      if (bodyBuffer.length > 0) socket.write(bodyBuffer);

      const chunks = [];
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('error', reject);
      socket.on('end', () => {
        try {
          const raw = Buffer.concat(chunks);
          const separator = raw.indexOf('\r\n\r\n');
          if (separator === -1) throw new Error('代理响应格式非法，缺少响应头');
          const headerText = raw.slice(0, separator).toString('utf8');
          const bodyRaw = raw.slice(separator + 4);
          const [statusLine, ...headerLines] = headerText.split('\r\n');
          const status = Number(statusLine.split(' ')[1]);
          const responseHeaders = {};
          for (const line of headerLines) {
            const index = line.indexOf(':');
            if (index > 0) {
              responseHeaders[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
            }
          }
          const bodyText = responseHeaders['transfer-encoding']?.includes('chunked')
            ? decodeChunked(bodyRaw)
            : bodyRaw.toString('utf8');
          resolve({
            ok: status >= 200 && status < 300,
            status,
            text: async () => bodyText,
          });
        } catch (error) {
          reject(error);
        }
      });
    });
  };
}

function truncate(text, max = 500) {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

function describeFetchError(error) {
  if (error?.name === 'TimeoutError') return `请求超时（${REQUEST_TIMEOUT_MS} 毫秒）`;
  if (error?.code === 'ENOTFOUND') return '域名解析失败，请检查 CODEARTS_REQ_ENDPOINT 是否正确';
  if (error?.code === 'ECONNREFUSED') return '连接被拒绝，请检查终端节点或代理是否可用';
  return error?.message || String(error);
}

async function callApi(method, path, { query, body } = {}) {
  const { endpoint, ak, sk, proxy } = getConfig();
  const normalizedPath = path.startsWith('/') ? path : '/' + path;
  const queryString = buildQueryString(query);
  const url = `${endpoint.replace(/\/+$/, '')}${normalizedPath}${queryString ? '?' + queryString : ''}`;
  const bodyString = body === undefined ? '' : JSON.stringify(body);
  const { authorization, xSdkDate } = buildSignature({ method, url, ak, sk, body: bodyString });

  const options = {
    method: String(method).toUpperCase(),
    headers: {
      Authorization: authorization,
      'X-Sdk-Date': xSdkDate,
      'Content-Type': 'application/json',
    },
  };
  if (body !== undefined) options.body = bodyString;

  let response;
  try {
    if (proxy) {
      const proxyFetch = createProxyFetch(proxy);
      response = await proxyFetch(url, options);
    } else {
      response = await fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    }
  } catch (error) {
    return makeError('NETWORK_ERROR', `网络请求失败：${describeFetchError(error)}`, { url });
  }

  let rawText = '';
  try {
    rawText = await response.text();
  } catch (error) {
    return makeError('NETWORK_ERROR', `读取响应体失败：${describeFetchError(error)}`, {
      http_status: response.status,
      url,
    });
  }

  let data = null;
  if (rawText.trim()) {
    try {
      data = JSON.parse(rawText);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const errorCode = data?.error_code || data?.error?.code || `HTTP_${response.status}`;
    const errorMsg =
      data?.error_msg ||
      data?.error?.message ||
      (rawText.trim() ? `接口返回非 JSON 错误响应：${truncate(rawText.trim())}` : `API 返回 HTTP ${response.status}`);
    return makeError(errorCode, errorMsg, {
      http_status: response.status,
      api_response: data ?? (rawText.trim() ? truncate(rawText.trim()) : undefined),
      url,
    });
  }

  if (!rawText.trim()) {
    return makeError('NETWORK_ERROR', '接口返回了空响应体，无法解析结果', {
      http_status: response.status,
      url,
    });
  }

  if (data === null) {
    return makeError('NETWORK_ERROR', '接口返回的响应体不是合法 JSON，无法解析结果', {
      http_status: response.status,
      api_response: truncate(rawText.trim()),
      url,
    });
  }

  const result = makeSuccess(data);
  result.data = data;
  return result;
}

async function handleCreateProject(args) {
  const configError = checkConfig();
  if (configError) return configError;

  const errors = validateCreateProject(args);
  if (errors.length > 0) {
    return makeError(
      'INVALID_ARGUMENTS',
      `参数校验失败：\n${errors.map((item, index) => `${index + 1}. ${item}`).join('\n')}`,
    );
  }

  const { project_name, project_type, description, enterprise_id, source, template_id } = args || {};
  const body = { project_name, project_type };
  if (description !== undefined) body.description = description;
  if (enterprise_id !== undefined) body.enterprise_id = enterprise_id;
  if (source !== undefined) body.source = source;
  if (template_id !== undefined && template_id !== null && template_id !== '') {
    body.template_id = Number(template_id);
  }

  const result = await callApi('POST', '/v4/project', { body });
  if (result.isError) return result;

  const data = result.data ?? {};
  const picked = {};
  for (const key of CREATE_PROJECT_FIELDS) {
    if (data[key] !== undefined) picked[key] = data[key];
  }
  return makeSuccess(Object.keys(picked).length > 0 ? picked : data);
}

async function handleListProjects(args) {
  const configError = checkConfig();
  if (configError) return configError;

  const errors = validateListProjects(args);
  if (errors.length > 0) {
    return makeError(
      'INVALID_ARGUMENTS',
      `参数校验失败：\n${errors.map((item, index) => `${index + 1}. ${item}`).join('\n')}`,
    );
  }

  const { offset, limit, search, project_type, sort, archive, query_type } = args || {};
  const query = {};
  if (offset !== undefined && offset !== null) query.offset = offset;
  if (limit !== undefined && limit !== null) query.limit = limit;
  if (search !== undefined) query.search = search;
  if (project_type !== undefined) query.project_type = project_type;
  if (sort !== undefined) query.sort = sort;
  if (archive !== undefined) query.archive = archive;
  if (query_type !== undefined) query.query_type = query_type;

  const result = await callApi('GET', '/v4/projects', { query });
  if (result.isError) return result;

  const data = result.data ?? {};
  const projects = Array.isArray(data.projects) ? data.projects : [];
  const total = Number(data.total);
  return makeSuccess({
    projects,
    total: Number.isFinite(total) ? total : projects.length,
  });
}

async function handleToolCall(name, args) {
  switch (name) {
    case 'create_project':
      return await handleCreateProject(args);
    case 'list_projects':
      return await handleListProjects(args);
    default:
      return makeError('INVALID_ARGUMENTS', `未知工具：${name}，当前仅支持 create_project 与 list_projects`);
  }
}

const TOOLS = [
  {
    name: 'create_project',
    description: '创建 CodeArts 需求管理项目（POST /v4/project）。project_type=ipd 时必须传 template_id。',
    inputSchema: {
      type: 'object',
      properties: {
        project_name: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          description: '项目名称（必填，1-128 字符）',
        },
        project_type: {
          type: 'string',
          enum: PROJECT_TYPES,
          description: '项目类型（必填）：scrum / normal / xboard / basic / phoenix / ipd',
        },
        description: { type: 'string', description: '项目描述（选填）' },
        enterprise_id: { type: 'string', description: '企业项目 ID（选填）' },
        source: { type: 'string', minLength: 0, maxLength: 64, description: '来源标识（选填，0-64 字符）' },
        template_id: {
          type: 'integer',
          enum: TEMPLATE_IDS,
          description: 'IPD 模板 ID（选填）：10001 / 10002 / 10003；project_type=ipd 时必传',
        },
      },
      required: ['project_name', 'project_type'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_projects',
    description: '查询 CodeArts 需求管理项目列表（GET /v4/projects），返回 projects 数组与 total。',
    inputSchema: {
      type: 'object',
      properties: {
        offset: {
          type: 'integer',
          minimum: 0,
          maximum: 10000,
          default: 0,
          description: '分页偏移量（选填，默认 0，范围 0-10000，须为 limit 的整数倍）',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
          default: 10,
          description: '每页数量（选填，默认 10，范围 1-1000）',
        },
        search: { type: 'string', description: '项目名称搜索关键字（选填）' },
        project_type: {
          type: 'string',
          enum: LIST_PROJECT_TYPES,
          description: '项目类型（选填）：scrum / normal / xboard',
        },
        sort: {
          type: 'string',
          description: '排序字段与方向（选填），格式 字段:asc|desc，多组用逗号分隔，最多 4 组',
        },
        archive: { type: 'boolean', description: '是否查询已归档项目（选填）' },
        query_type: {
          type: 'string',
          enum: QUERY_TYPES,
          description: '查询范围（选填）：domain_projects / absent',
        },
      },
      additionalProperties: false,
    },
  },
];

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  {
    capabilities: { tools: {} },
    instructions:
      'CodeArts 需求管理 MCP Server。使用前请配置环境变量 CODEARTS_REQ_ENDPOINT、CODEARTS_REQ_AK、CODEARTS_REQ_SK。' +
      '提供 create_project（创建项目）与 list_projects（查询项目列表）两个工具。',
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params ?? {};
    return await handleToolCall(name, args);
  } catch (error) {
    console.error(`[${SERVER_NAME}] 工具调用异常：`, error);
    return makeError('INTERNAL_ERROR', `服务内部错误：${error?.message || String(error)}`);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${SERVER_NAME}] MCP Server 已启动（stdio），等待 JSON-RPC 消息`);
}

const isDirectRun = (() => {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((error) => {
    console.error(`[${SERVER_NAME}] MCP Server 启动失败：`, error);
    process.exit(1);
  });
}

export {
  SERVER_NAME,
  SERVER_VERSION,
  REQUEST_TIMEOUT_MS,
  PROJECT_TYPES,
  LIST_PROJECT_TYPES,
  TEMPLATE_IDS,
  QUERY_TYPES,
  TOOLS,
  makeError,
  makeSuccess,
  getConfig,
  checkConfig,
  sha256Hex,
  hmacSHA256Hex,
  formatSdkDate,
  uriEncode,
  buildQueryString,
  canonicalizeQuery,
  canonicalUri,
  buildSignature,
  validateCreateProject,
  validateListProjects,
  createProxyFetch,
  decodeChunked,
  callApi,
  handleCreateProject,
  handleListProjects,
  handleToolCall,
};