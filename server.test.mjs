import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  SERVER_NAME,
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
} from './server.mjs';

const ORIG_ENV = { ...process.env };
const ORIG_FETCH = globalThis.fetch;

function setEnv(env = {}) {
  delete process.env.CODEARTS_REQ_ENDPOINT;
  delete process.env.CODEARTS_REQ_AK;
  delete process.env.CODEARTS_REQ_SK;
  delete process.env.CODEARTS_REQ_PROXY;
  Object.assign(process.env, env);
}

function validEnv() {
  return {
    CODEARTS_REQ_ENDPOINT: 'https://projectman-ext.cn-north-4.myhuaweicloud.com',
    CODEARTS_REQ_AK: 'test-ak',
    CODEARTS_REQ_SK: 'test-sk',
  };
}

function parseContent(result) {
  return JSON.parse(result.content[0].text);
}

function mockResponse({ status = 200, body = '' } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  };
}

function mockFetchOnce(response) {
  globalThis.fetch = async () => response;
}

function mockFetch(factory) {
  globalThis.fetch = factory;
}

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  setEnv(ORIG_ENV);
});

describe('基础工具', () => {
  test('服务名与常量符合约定', () => {
    assert.equal(SERVER_NAME, 'codearts-req');
    assert.deepEqual(PROJECT_TYPES, ['scrum', 'normal', 'xboard', 'basic', 'phoenix', 'ipd']);
    assert.deepEqual(LIST_PROJECT_TYPES, ['scrum', 'normal', 'xboard']);
    assert.deepEqual(TEMPLATE_IDS, [10001, 10002, 10003]);
    assert.deepEqual(QUERY_TYPES, ['domain_projects', 'absent']);
  });

  test('makeError 返回中文结构化错误，isError 为 true', () => {
    const result = makeError('INVALID_ARGUMENTS', '参数非法', { field: 'project_name' });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].type, 'text');
    const payload = parseContent(result);
    assert.equal(payload.error, true);
    assert.equal(payload.error_code, 'INVALID_ARGUMENTS');
    assert.equal(payload.error_msg, '参数非法');
    assert.equal(payload.field, 'project_name');
  });

  test('makeSuccess 返回 isError=false 的 JSON 文本', () => {
    const result = makeSuccess({ total: 1 });
    assert.equal(result.isError, false);
    assert.deepEqual(parseContent(result), { total: 1 });
  });

  test('sha256Hex 结果正确', () => {
    assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  test('formatSdkDate 输出 UTC 的 YYYYMMDDTHHmmssZ', () => {
    assert.equal(formatSdkDate(new Date('2026-01-02T03:04:05.678Z')), '20260102T030405Z');
    assert.match(formatSdkDate(), /^\d{8}T\d{6}Z$/);
  });

  test('uriEncode 与华为云 SDK 编码规则一致', () => {
    assert.equal(uriEncode('a b'), 'a%20b');
    assert.equal(uriEncode('a:b'), 'a%3Ab');
    assert.equal(uriEncode("a!b'c(d)e*f"), 'a%21b%27c%28d%29e%2Af');
    assert.equal(uriEncode('1+1'), '1+1');
    assert.equal(uriEncode('华为 云'), '%E5%8D%8E%E4%B8%BA%20%E4%BA%91');
    assert.equal(uriEncode('a-b_c.d~e'), 'a-b_c.d~e');
  });
});

describe('配置读取', () => {
  test('getConfig 去除首尾空白', () => {
    setEnv({
      CODEARTS_REQ_ENDPOINT: ' https://x.com ',
      CODEARTS_REQ_AK: ' ak ',
      CODEARTS_REQ_SK: ' sk ',
      CODEARTS_REQ_PROXY: ' socks5://127.0.0.1:1080 ',
    });
    assert.deepEqual(getConfig(), {
      endpoint: 'https://x.com',
      ak: 'ak',
      sk: 'sk',
      proxy: 'socks5://127.0.0.1:1080',
    });
  });

  test('缺 ENDPOINT 返回 MISSING_CONFIG', () => {
    setEnv({ CODEARTS_REQ_AK: 'ak', CODEARTS_REQ_SK: 'sk' });
    const result = checkConfig();
    assert.equal(result.isError, true);
    const payload = parseContent(result);
    assert.equal(payload.error_code, 'MISSING_CONFIG');
    assert.match(payload.error_msg, /CODEARTS_REQ_ENDPOINT/);
  });

  test('ENDPOINT 不是合法 URL 返回 MISSING_CONFIG', () => {
    setEnv({ CODEARTS_REQ_ENDPOINT: 'not-a-url', CODEARTS_REQ_AK: 'ak', CODEARTS_REQ_SK: 'sk' });
    const result = checkConfig();
    assert.equal(result.isError, true);
    assert.equal(parseContent(result).error_code, 'MISSING_CONFIG');
  });

  test('ENDPOINT 协议不支持返回 MISSING_CONFIG', () => {
    setEnv({ CODEARTS_REQ_ENDPOINT: 'ftp://x.com', CODEARTS_REQ_AK: 'ak', CODEARTS_REQ_SK: 'sk' });
    const result = checkConfig();
    assert.equal(result.isError, true);
    assert.match(parseContent(result).error_msg, /http/);
  });

  test('缺 AK 返回 MISSING_CONFIG', () => {
    setEnv({ CODEARTS_REQ_ENDPOINT: 'https://x.com', CODEARTS_REQ_SK: 'sk' });
    const payload = parseContent(checkConfig());
    assert.equal(payload.error_code, 'MISSING_CONFIG');
    assert.match(payload.error_msg, /CODEARTS_REQ_AK/);
  });

  test('缺 SK 返回 MISSING_CONFIG', () => {
    setEnv({ CODEARTS_REQ_ENDPOINT: 'https://x.com', CODEARTS_REQ_AK: 'ak' });
    const payload = parseContent(checkConfig());
    assert.equal(payload.error_code, 'MISSING_CONFIG');
    assert.match(payload.error_msg, /CODEARTS_REQ_SK/);
  });

  test('配置齐全返回 null', () => {
    setEnv(validEnv());
    assert.equal(checkConfig(), null);
  });
});

describe('create_project 参数校验', () => {
  test('合法参数通过', () => {
    assert.deepEqual(validateCreateProject({ project_name: 'p', project_type: 'scrum' }), []);
    assert.deepEqual(validateCreateProject({ project_name: 'x'.repeat(128), project_type: 'normal' }), []);
  });

  test('ipd 且 template_id 为数字或数字字符串均合法', () => {
    assert.deepEqual(validateCreateProject({ project_name: 'p', project_type: 'ipd', template_id: 10001 }), []);
    assert.deepEqual(validateCreateProject({ project_name: 'p', project_type: 'ipd', template_id: '10003' }), []);
  });

  test('缺 project_name', () => {
    const errors = validateCreateProject({ project_type: 'scrum' });
    assert.ok(errors.some((item) => item.includes('project_name')));
  });

  test('project_name 为空或超长', () => {
    assert.ok(validateCreateProject({ project_name: '', project_type: 'scrum' }).length > 0);
    assert.ok(validateCreateProject({ project_name: 'x'.repeat(129), project_type: 'scrum' }).length > 0);
  });

  test('project_type 缺失或非法', () => {
    assert.ok(validateCreateProject({ project_name: 'p' }).length > 0);
    assert.ok(validateCreateProject({ project_name: 'p', project_type: 'unknown' }).length > 0);
  });

  test('source 边界 0 与 64 合法，65 非法', () => {
    assert.deepEqual(validateCreateProject({ project_name: 'p', project_type: 'scrum', source: '' }), []);
    assert.deepEqual(validateCreateProject({ project_name: 'p', project_type: 'scrum', source: 'x'.repeat(64) }), []);
    assert.ok(validateCreateProject({ project_name: 'p', project_type: 'scrum', source: 'x'.repeat(65) }).length > 0);
  });

  test('template_id 非法', () => {
    const errors = validateCreateProject({ project_name: 'p', project_type: 'scrum', template_id: 99999 });
    assert.ok(errors.some((item) => item.includes('template_id')));
  });

  test('project_type=ipd 时必须传 template_id', () => {
    const errors = validateCreateProject({ project_name: 'p', project_type: 'ipd' });
    assert.ok(errors.some((item) => item.includes('template_id')));
  });

  test('description 与 enterprise_id 必须为字符串', () => {
    assert.ok(validateCreateProject({ project_name: 'p', project_type: 'scrum', description: 1 }).length > 0);
    assert.ok(validateCreateProject({ project_name: 'p', project_type: 'scrum', enterprise_id: 1 }).length > 0);
  });
});

describe('list_projects 参数校验', () => {
  test('空参数与 undefined 均合法', () => {
    assert.deepEqual(validateListProjects({}), []);
    assert.deepEqual(validateListProjects(undefined), []);
  });

  test('offset 必须为 limit 的整数倍', () => {
    assert.ok(validateListProjects({ offset: 5, limit: 10 }).some((item) => item.includes('整数倍')));
    assert.deepEqual(validateListProjects({ offset: 20, limit: 10 }), []);
    assert.deepEqual(validateListProjects({ offset: 10000, limit: 1000 }), []);
  });

  test('offset 越界或非整数', () => {
    assert.ok(validateListProjects({ offset: 10001, limit: 10 }).length > 0);
    assert.ok(validateListProjects({ offset: -1, limit: 10 }).length > 0);
    assert.ok(validateListProjects({ offset: 1.5, limit: 10 }).length > 0);
  });

  test('limit 越界或非整数', () => {
    assert.ok(validateListProjects({ limit: 0 }).length > 0);
    assert.ok(validateListProjects({ limit: 1001 }).length > 0);
    assert.ok(validateListProjects({ limit: 1.5 }).length > 0);
  });

  test('limit 非法时不重复报整数倍错误', () => {
    const errors = validateListProjects({ offset: 5, limit: 0 });
    assert.equal(errors.filter((item) => item.includes('整数倍')).length, 0);
    assert.ok(errors.some((item) => item.includes('limit')));
  });

  test('project_type 仅允许三种', () => {
    assert.deepEqual(validateListProjects({ project_type: 'scrum' }), []);
    assert.ok(validateListProjects({ project_type: 'ipd' }).length > 0);
  });

  test('sort 格式与组数', () => {
    assert.deepEqual(validateListProjects({ sort: 'project_name:asc' }), []);
    assert.deepEqual(validateListProjects({ sort: 'a:asc,b:desc,c:asc,d:DESC' }), []);
    assert.ok(validateListProjects({ sort: 'a:asc,b:desc,c:asc,d:desc,e:asc' }).some((item) => item.includes('4 组')));
    assert.ok(validateListProjects({ sort: 'a:up' }).some((item) => item.includes('格式非法')));
    assert.ok(validateListProjects({ sort: 'a' }).length > 0);
  });

  test('archive 与 query_type', () => {
    assert.deepEqual(validateListProjects({ archive: true, query_type: 'absent' }), []);
    assert.ok(validateListProjects({ archive: 'yes' }).length > 0);
    assert.ok(validateListProjects({ query_type: 'unknown' }).length > 0);
  });
});

describe('签名构造', () => {
  const date = new Date('2026-01-02T03:04:05Z');

  test('canonicalUri 规范为以 / 开头且以 / 结尾', () => {
    assert.equal(canonicalUri('/v4/project'), '/v4/project/');
    assert.equal(canonicalUri('/v4/project/'), '/v4/project/');
    assert.equal(canonicalUri('/'), '/');
    assert.equal(canonicalUri(''), '/');
  });

  test('canonicalizeQuery 按键值排序并规范化编码', () => {
    assert.equal(canonicalizeQuery('?limit=10&offset=0'), 'limit=10&offset=0');
    assert.equal(canonicalizeQuery('offset=0&limit=10'), 'limit=10&offset=0');
    assert.equal(canonicalizeQuery('search=a%20b&sort=name%3Aasc'), 'search=a%20b&sort=name%3Aasc');
    assert.equal(canonicalizeQuery(''), '');
  });

  test('buildQueryString 忽略 undefined/null 并排序', () => {
    assert.equal(buildQueryString({ b: 2, a: 'x y', c: undefined, d: null }), 'a=x%20y&b=2');
    assert.equal(buildQueryString({ archive: false }), 'archive=false');
  });

  test('GET 请求生成合法签名头与规范化请求串', () => {
    const { authorization, xSdkDate, canonicalRequest } = buildSignature({
      method: 'GET',
      url: 'https://projectman-ext.cn-north-4.myhuaweicloud.com/v4/projects?offset=0&limit=10',
      ak: 'HPUA1HOZVWWBGMPPVKOA',
      sk: 'test-secret-key',
      body: '',
      date,
    });
    assert.match(
      authorization,
      /^SDK-HMAC-SHA256 Access=HPUA1HOZVWWBGMPPVKOA, SignedHeaders=host;x-sdk-date, Signature=[0-9a-f]{64}$/,
    );
    assert.equal(xSdkDate, '20260102T030405Z');
    assert.match(canonicalRequest, /^GET\n\/v4\/projects\/\nlimit=10&offset=0\nhost:projectman-ext\.cn-north-4\.myhuaweicloud\.com\nx-sdk-date:20260102T030405Z\n\nhost;x-sdk-date\n[0-9a-f]{64}$/);
  });

  test('查询串顺序不影响签名', () => {
    const base = { method: 'GET', ak: 'ak', sk: 'sk', body: '', date };
    const first = buildSignature({ ...base, url: 'https://x.com/v4/projects?limit=10&offset=0' });
    const second = buildSignature({ ...base, url: 'https://x.com/v4/projects?offset=0&limit=10' });
    assert.equal(first.authorization, second.authorization);
  });

  test('非默认端口写入 host 参与签名', () => {
    const { canonicalRequest } = buildSignature({
      method: 'GET',
      url: 'http://127.0.0.1:18080/v4/projects',
      ak: 'ak',
      sk: 'sk',
      body: '',
      date,
    });
    assert.match(canonicalRequest, /host:127\.0\.0\.1:18080/);
  });

  test('POST body 参与签名，不同 body 得到不同签名', () => {
    const base = { method: 'POST', url: 'https://x.com/v4/project', ak: 'ak', sk: 'sk', date };
    const first = buildSignature({ ...base, body: '{"project_name":"a"}' });
    const second = buildSignature({ ...base, body: '{"project_name":"b"}' });
    assert.notEqual(first.authorization, second.authorization);
    assert.notEqual(first.stringToSign, second.stringToSign);
  });

  test('不同 SK 产生不同签名', () => {
    const base = { method: 'GET', url: 'https://x.com/v4/projects', ak: 'ak', body: '', date };
    assert.notEqual(
      buildSignature({ ...base, sk: 'sk1' }).authorization,
      buildSignature({ ...base, sk: 'sk2' }).authorization,
    );
  });
});

describe('代理与分块响应', () => {
  test('代理地址格式非法时抛错', () => {
    assert.throws(() => createProxyFetch('127.0.0.1:1080'), /不支持的代理地址/);
    assert.throws(() => createProxyFetch('http://127.0.0.1:8080'), /暂不支持/);
    assert.throws(() => createProxyFetch('socks5://127.0.0.1:99999'), /端口非法/);
  });

  test('合法 socks5 地址可创建 fetch', () => {
    assert.equal(typeof createProxyFetch('socks5://127.0.0.1:1080'), 'function');
  });

  test('decodeChunked 正确拼接分块响应', () => {
    const raw = Buffer.from('4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n', 'utf8');
    assert.equal(decodeChunked(raw), 'Wikipedia');
  });

  test('decodeChunked 忽略非法块长度', () => {
    const raw = Buffer.from('zz\r\nabc\r\n0\r\n\r\n', 'utf8');
    assert.equal(decodeChunked(raw), '');
  });
});

describe('callApi', () => {
  test('endpoint 末尾斜杠被规整', async () => {
    setEnv({ ...validEnv(), CODEARTS_REQ_ENDPOINT: 'https://x.com/' });
    let capturedUrl;
    mockFetch(async (url) => {
      capturedUrl = url;
      return mockResponse({ body: {} });
    });
    await callApi('GET', '/v4/projects');
    assert.equal(capturedUrl, 'https://x.com/v4/projects');
  });

  test('请求头携带 Authorization 与 X-Sdk-Date', async () => {
    setEnv(validEnv());
    let captured;
    mockFetch(async (_url, options) => {
      captured = options;
      return mockResponse({ body: { projects: [], total: 0 } });
    });
    await callApi('GET', '/v4/projects');
    assert.match(
      captured.headers.Authorization,
      /^SDK-HMAC-SHA256 Access=test-ak, SignedHeaders=host;x-sdk-date, Signature=[0-9a-f]{64}$/,
    );
    assert.match(captured.headers['X-Sdk-Date'], /^\d{8}T\d{6}Z$/);
    assert.equal(captured.headers['X-Auth-Token'], undefined);
    assert.ok(captured.signal instanceof AbortSignal);
  });

  test('响应体不是 JSON 且状态成功时返回 NETWORK_ERROR', async () => {
    setEnv(validEnv());
    mockFetchOnce(mockResponse({ status: 200, body: '<html>ok</html>' }));
    const result = await callApi('GET', '/v4/projects');
    assert.equal(result.isError, true);
    const payload = parseContent(result);
    assert.equal(payload.error_code, 'NETWORK_ERROR');
    assert.match(payload.error_msg, /不是合法 JSON/);
  });

  test('响应体为空时返回 NETWORK_ERROR', async () => {
    setEnv(validEnv());
    mockFetchOnce(mockResponse({ status: 200, body: '' }));
    const result = await callApi('GET', '/v4/projects');
    assert.equal(parseContent(result).error_code, 'NETWORK_ERROR');
  });

  test('HTTP 错误且响应非 JSON 时透传 http_status', async () => {
    setEnv(validEnv());
    mockFetchOnce(mockResponse({ status: 502, body: 'Bad Gateway' }));
    const payload = parseContent(await callApi('GET', '/v4/projects'));
    assert.equal(payload.error_code, 'HTTP_502');
    assert.equal(payload.http_status, 502);
    assert.match(payload.error_msg, /Bad Gateway/);
  });

  test('HTTP 错误且无 error_code 时使用 HTTP_status 兜底', async () => {
    setEnv(validEnv());
    mockFetchOnce(mockResponse({ status: 503, body: { msg: 'unavailable' } }));
    const payload = parseContent(await callApi('GET', '/v4/projects'));
    assert.equal(payload.error_code, 'HTTP_503');
    assert.equal(payload.http_status, 503);
  });

  test('嵌套 error.code/error.message 也会透传', async () => {
    setEnv(validEnv());
    mockFetchOnce(mockResponse({ status: 400, body: { error: { code: 'Req.0400', message: '参数错误' } } }));
    const payload = parseContent(await callApi('GET', '/v4/projects'));
    assert.equal(payload.error_code, 'Req.0400');
    assert.equal(payload.error_msg, '参数错误');
    assert.equal(payload.http_status, 400);
  });

  test('网络异常返回 NETWORK_ERROR', async () => {
    setEnv(validEnv());
    mockFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const payload = parseContent(await callApi('GET', '/v4/projects'));
    assert.equal(payload.error_code, 'NETWORK_ERROR');
    assert.match(payload.error_msg, /fetch failed/);
  });

  test('请求超时返回 NETWORK_ERROR 中文提示', async () => {
    setEnv(validEnv());
    mockFetch(async () => {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      throw error;
    });
    const payload = parseContent(await callApi('GET', '/v4/projects'));
    assert.equal(payload.error_code, 'NETWORK_ERROR');
    assert.match(payload.error_msg, /请求超时/);
  });

  test('代理配置非法时返回 NETWORK_ERROR 而不是崩溃', async () => {
    setEnv({ ...validEnv(), CODEARTS_REQ_PROXY: 'bad-proxy' });
    const payload = parseContent(await callApi('GET', '/v4/projects'));
    assert.equal(payload.error_code, 'NETWORK_ERROR');
    assert.match(payload.error_msg, /代理/);
  });
});

describe('create_project 工具', () => {
  test('缺配置返回 MISSING_CONFIG', async () => {
    setEnv({});
    const result = await handleCreateProject({ project_name: 'p', project_type: 'scrum' });
    assert.equal(result.isError, true);
    assert.equal(parseContent(result).error_code, 'MISSING_CONFIG');
  });

  test('参数非法返回 INVALID_ARGUMENTS', async () => {
    setEnv(validEnv());
    const result = await handleCreateProject({ project_type: 'scrum' });
    assert.equal(result.isError, true);
    const payload = parseContent(result);
    assert.equal(payload.error_code, 'INVALID_ARGUMENTS');
    assert.match(payload.error_msg, /project_name/);
  });

  test('args 为 undefined 时返回 INVALID_ARGUMENTS', async () => {
    setEnv(validEnv());
    const payload = parseContent(await handleCreateProject(undefined));
    assert.equal(payload.error_code, 'INVALID_ARGUMENTS');
  });

  test('API 成功仅返回约定的 5 个字段', async () => {
    setEnv(validEnv());
    mockFetchOnce(
      mockResponse({
        body: {
          project_id: 'pid-1',
          project_num_id: 100,
          project_name: 'demo',
          project_type: 'scrum',
          user_num_id: 200,
          description: '不应被返回',
        },
      }),
    );
    const result = await handleCreateProject({ project_name: 'demo', project_type: 'scrum' });
    assert.equal(result.isError, false);
    assert.deepEqual(parseContent(result), {
      project_id: 'pid-1',
      project_num_id: 100,
      project_name: 'demo',
      project_type: 'scrum',
      user_num_id: 200,
    });
  });

  test('响应缺少约定字段时原样返回，不丢数据', async () => {
    setEnv(validEnv());
    mockFetchOnce(mockResponse({ body: { status: 'success' } }));
    assert.deepEqual(parseContent(await handleCreateProject({ project_name: 'p', project_type: 'scrum' })), {
      status: 'success',
    });
  });

  test('请求体与请求头正确，ipd 模板以整数提交', async () => {
    setEnv(validEnv());
    let captured;
    mockFetch(async (url, options) => {
      captured = { url, options };
      return mockResponse({ body: { project_id: '1' } });
    });
    await handleCreateProject({
      project_name: 'demo',
      project_type: 'ipd',
      description: 'desc',
      enterprise_id: 'ent-1',
      source: 'src',
      template_id: '10002',
    });
    assert.equal(captured.url, 'https://projectman-ext.cn-north-4.myhuaweicloud.com/v4/project');
    assert.equal(captured.options.method, 'POST');
    assert.deepEqual(JSON.parse(captured.options.body), {
      project_name: 'demo',
      project_type: 'ipd',
      description: 'desc',
      enterprise_id: 'ent-1',
      source: 'src',
      template_id: 10002,
    });
  });

  test('未传选填参数时请求体不包含对应键', async () => {
    setEnv(validEnv());
    let capturedBody;
    mockFetch(async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return mockResponse({ body: { project_id: '1' } });
    });
    await handleCreateProject({ project_name: 'p', project_type: 'scrum' });
    assert.deepEqual(capturedBody, { project_name: 'p', project_type: 'scrum' });
  });

  test('API 报错透传 error_code/error_msg/http_status', async () => {
    setEnv(validEnv());
    mockFetchOnce(mockResponse({ status: 400, body: { error_code: 'PM.00000001', error_msg: 'param error' } }));
    const result = await handleCreateProject({ project_name: 'demo', project_type: 'scrum' });
    assert.equal(result.isError, true);
    const payload = parseContent(result);
    assert.equal(payload.error_code, 'PM.00000001');
    assert.equal(payload.error_msg, 'param error');
    assert.equal(payload.http_status, 400);
  });

  test('网络异常返回 NETWORK_ERROR', async () => {
    setEnv(validEnv());
    mockFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const payload = parseContent(await handleCreateProject({ project_name: 'demo', project_type: 'scrum' }));
    assert.equal(payload.error_code, 'NETWORK_ERROR');
  });
});

describe('list_projects 工具', () => {
  test('缺配置返回 MISSING_CONFIG', async () => {
    setEnv({});
    const payload = parseContent(await handleListProjects({}));
    assert.equal(payload.error_code, 'MISSING_CONFIG');
  });

  test('参数非法返回 INVALID_ARGUMENTS', async () => {
    setEnv(validEnv());
    const payload = parseContent(await handleListProjects({ offset: 5, limit: 10 }));
    assert.equal(payload.error_code, 'INVALID_ARGUMENTS');
    assert.match(payload.error_msg, /整数倍/);
  });

  test('无参数时不拼接查询串', async () => {
    setEnv(validEnv());
    let capturedUrl;
    mockFetch(async (url) => {
      capturedUrl = url;
      return mockResponse({ body: { projects: [], total: 0 } });
    });
    await handleListProjects({});
    assert.equal(capturedUrl, 'https://projectman-ext.cn-north-4.myhuaweicloud.com/v4/projects');
  });

  test('查询参数按键排序并进行 URL 编码', async () => {
    setEnv(validEnv());
    let capturedUrl;
    mockFetch(async (url) => {
      capturedUrl = url;
      return mockResponse({ body: { projects: [], total: 0 } });
    });
    await handleListProjects({
      offset: 20,
      limit: 10,
      search: '华为 云',
      project_type: 'scrum',
      sort: 'name:asc,created_on:desc',
      archive: false,
      query_type: 'domain_projects',
    });
    assert.equal(
      capturedUrl,
      'https://projectman-ext.cn-north-4.myhuaweicloud.com/v4/projects?' +
        'archive=false&limit=10&offset=20&project_type=scrum&query_type=domain_projects&' +
        'search=%E5%8D%8E%E4%B8%BA%20%E4%BA%91&sort=name%3Aasc%2Ccreated_on%3Adesc',
    );
  });

  test('API 成功返回 projects 与 total', async () => {
    setEnv(validEnv());
    mockFetchOnce(mockResponse({ body: { projects: [{ id: 1 }, { id: 2 }], total: 2, extra: 'x' } }));
    const payload = parseContent(await handleListProjects({}));
    assert.deepEqual(payload.projects, [{ id: 1 }, { id: 2 }]);
    assert.equal(payload.total, 2);
  });

  test('total 为数字字符串时转为数字', async () => {
    setEnv(validEnv());
    mockFetchOnce(mockResponse({ body: { projects: [{ id: 1 }], total: '1' } }));
    assert.equal(parseContent(await handleListProjects({})).total, 1);
  });

  test('缺少 projects 字段时返回空数组', async () => {
    setEnv(validEnv());
    mockFetchOnce(mockResponse({ body: {} }));
    assert.deepEqual(parseContent(await handleListProjects({})), { projects: [], total: 0 });
  });

  test('API 报错透传', async () => {
    setEnv(validEnv());
    mockFetchOnce(mockResponse({ status: 500, body: { error_code: 'internal', error_msg: '内部错误' } }));
    const payload = parseContent(await handleListProjects({}));
    assert.equal(payload.error_code, 'internal');
    assert.equal(payload.error_msg, '内部错误');
    assert.equal(payload.http_status, 500);
  });

  test('网络异常返回 NETWORK_ERROR', async () => {
    setEnv(validEnv());
    mockFetch(async () => {
      throw new Error('connection reset');
    });
    assert.equal(parseContent(await handleListProjects({})).error_code, 'NETWORK_ERROR');
  });
});

describe('handleToolCall', () => {
  test('路由到 create_project', async () => {
    setEnv({});
    const payload = parseContent(await handleToolCall('create_project', { project_name: 'p', project_type: 'scrum' }));
    assert.equal(payload.error_code, 'MISSING_CONFIG');
  });

  test('路由到 list_projects', async () => {
    setEnv({});
    const payload = parseContent(await handleToolCall('list_projects', {}));
    assert.equal(payload.error_code, 'MISSING_CONFIG');
  });

  test('未知工具返回 INVALID_ARGUMENTS', async () => {
    const payload = parseContent(await handleToolCall('delete_project', {}));
    assert.equal(payload.error_code, 'INVALID_ARGUMENTS');
    assert.match(payload.error_msg, /未知工具/);
  });
});

describe('工具清单', () => {
  test('暴露两个工具且名称正确', () => {
    assert.deepEqual(
      TOOLS.map((tool) => tool.name),
      ['create_project', 'list_projects'],
    );
  });

  test('create_project schema 的必填项与枚举正确', () => {
    const [tool] = TOOLS;
    assert.deepEqual(tool.inputSchema.required, ['project_name', 'project_type']);
    assert.equal(tool.inputSchema.properties.project_name.maxLength, 128);
    assert.deepEqual(tool.inputSchema.properties.project_type.enum, PROJECT_TYPES);
    assert.deepEqual(tool.inputSchema.properties.template_id.enum, TEMPLATE_IDS);
    assert.equal(tool.inputSchema.properties.template_id.type, 'integer');
    assert.equal(tool.inputSchema.properties.source.maxLength, 64);
  });

  test('list_projects schema 的默认值与范围正确', () => {
    const [, tool] = TOOLS;
    assert.equal(tool.inputSchema.properties.offset.default, 0);
    assert.equal(tool.inputSchema.properties.offset.maximum, 10000);
    assert.equal(tool.inputSchema.properties.limit.default, 10);
    assert.equal(tool.inputSchema.properties.limit.maximum, 1000);
    assert.deepEqual(tool.inputSchema.properties.project_type.enum, LIST_PROJECT_TYPES);
    assert.deepEqual(tool.inputSchema.properties.query_type.enum, QUERY_TYPES);
    assert.equal(tool.inputSchema.properties.archive.type, 'boolean');
  });
});