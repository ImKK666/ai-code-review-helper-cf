import { describe, it, expect, vi, beforeEach, afterEach, type Mock, beforeAll } from 'vitest';
import type { ExecutionContext, KVNamespace, Queue } from '@cloudflare/workers-types';
import worker, { Env as WebhookEnv } from '../index'; 
import { webcrypto } from 'node:crypto'; 

// Polyfill crypto for Node.js environment if not already available via Vitest config
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = webcrypto as any;
}

const getMiniflareBindings = (): WebhookEnv => ({
  PROCESSED_EVENTS_KV: {
    get: vi.fn(),
    put: vi.fn(),
  } as any, // Using 'as any' to simplify mock typing for KVNamespace
  REVIEW_TASKS_QUEUE: {
    send: vi.fn(),
  } as any, // Using 'as any' to simplify mock typing for Queue
  GITHUB_WEBHOOK_SECRET: 'test-github-secret',
  GITLAB_WEBHOOK_SECRET: 'test-gitlab-secret',
});

// Helper to create a mock Request object
const createMockRequest = (
  method: string,
  urlPath: string,
  body: any,
  headers: Record<string, string> = {}
): Request => {
  const url = new URL(`http://localhost${urlPath}`);
  const requestOptions: RequestInit = {
    method,
    headers: new Headers(headers),
  };
  if (body !== null && body !== undefined) {
    if (headers['content-type'] === 'application/json') {
      requestOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
    } else {
      requestOptions.body = body as BodyInit;
    }
  }
  return new Request(url.toString(), requestOptions);
};

// Helper to generate HMAC SHA256 signature for testing GitHub webhooks
async function generateGithubSignature(secret: string, payloadString: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(payloadString));
  const hashArray = Array.from(new Uint8Array(signatureBuffer));
  return `sha256=${hashArray.map(b => b.toString(16).padStart(2, '0')).join('')}`;
}

describe('worker-webhook', () => {
  let env: WebhookEnv;
  let mockExecutionContext: ExecutionContext;

  beforeEach(() => {
    env = getMiniflareBindings();
    mockExecutionContext = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    vi.clearAllMocks();
    (env.PROCESSED_EVENTS_KV.get as Mock).mockReset();
    (env.PROCESSED_EVENTS_KV.put as Mock).mockReset();
    (env.REVIEW_TASKS_QUEUE.send as Mock).mockReset();
    
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    if ((console.log as Mock).mockReset) (console.log as Mock).mockReset();
    if ((console.warn as Mock).mockReset) (console.warn as Mock).mockReset();
    if ((console.error as Mock).mockReset) (console.error as Mock).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Request Validation', () => {
    it('should return 405 if method is not POST', async () => {
      const request = createMockRequest('GET', '/webhook/github', null);
      const response = await worker.fetch(request, env, mockExecutionContext);
      expect(response.status).toBe(405);
      const json = await response.json();
      expect(json).toEqual({ error: 'Method Not Allowed' });
    });

    it('should return 400 if source is invalid', async () => {
      const request = createMockRequest('POST', '/webhook/invalid-source', {}, { 'content-type': 'application/json' });
      const response = await worker.fetch(request, env, mockExecutionContext);
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json).toEqual({ error: 'Invalid source. Must be "github" or "gitlab".' });
    });
    
    it('should return 400 if source is missing', async () => {
        const request = createMockRequest('POST', '/webhook/', {}, { 'content-type': 'application/json' });
        const response = await worker.fetch(request, env, mockExecutionContext);
        expect(response.status).toBe(400);
        const json = await response.json();
        expect(json).toEqual({ error: 'Invalid source. Must be "github" or "gitlab".' });
      });

    it('should return 400 if content-type is not application/json', async () => {
      const request = createMockRequest('POST', '/webhook/github', "plain text body", { 'content-type': 'text/plain' });
      const response = await worker.fetch(request, env, mockExecutionContext);
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json).toEqual({ error: 'Invalid content type. Must be application/json.' });
    });

    it('should return 400 if JSON payload is invalid', async () => {
      const request = createMockRequest('POST', '/webhook/github', "invalid json", { 'content-type': 'application/json' });
      const response = await worker.fetch(request, env, mockExecutionContext);
      expect(response.status).toBe(400);
      const json = await response.json() as any;
      expect(json.error).toContain('Invalid JSON payload.');
    });
    
    it('should return 404 for non-webhook paths', async () => {
        const request = createMockRequest('POST', '/not-a-webhook', {}, { 'content-type': 'application/json' });
        const response = await worker.fetch(request, env, mockExecutionContext);
        expect(response.status).toBe(404);
        const json = await response.json();
        expect(json).toEqual({ error: 'Not found.' });
    });
  });

  describe('Signature Verification', () => {
    const mockPayload = { data: 'test-payload' };
    const rawBody = JSON.stringify(mockPayload);

    it('GitHub: should return 401 if signature is invalid', async () => {
      const request = createMockRequest('POST', '/webhook/github', mockPayload, { 
        'content-type': 'application/json',
        'X-Hub-Signature-256': 'sha256=invalidsignature',
        'X-GitHub-Delivery': 'test-delivery-id' 
      });
      (env.PROCESSED_EVENTS_KV.get as Mock).mockResolvedValue(null); 
      const response = await worker.fetch(request, env, mockExecutionContext);
      expect(response.status).toBe(401);
      const json = await response.json();
      expect(json).toEqual({ error: 'Invalid signature.' });
    });

    it('GitHub: should return 401 if X-Hub-Signature-256 header is missing', async () => {
      const request = createMockRequest('POST', '/webhook/github', mockPayload, { 
        'content-type': 'application/json',
        'X-GitHub-Delivery': 'test-delivery-id'
      });
      const response = await worker.fetch(request, env, mockExecutionContext);
      expect(response.status).toBe(401);
      const json = await response.json();
      expect(json).toEqual({ error: 'Invalid signature.' });
      expect(console.warn).toHaveBeenCalledWith('GitHub webhook missing X-Hub-Signature-256 header.');
    });

    it('GitHub: should return 401 if GITHUB_WEBHOOK_SECRET is not set', async () => {
      env.GITHUB_WEBHOOK_SECRET = undefined;
      const signature = await generateGithubSignature('any-secret-for-generation', rawBody);
      const request = createMockRequest('POST', '/webhook/github', mockPayload, { 
        'content-type': 'application/json',
        'X-Hub-Signature-256': signature,
        'X-GitHub-Delivery': 'test-delivery-id'
      });
      const response = await worker.fetch(request, env, mockExecutionContext);
      expect(response.status).toBe(401);
      const json = await response.json();
      expect(json).toEqual({ error: 'Invalid signature.' });
      expect(console.error).toHaveBeenCalledWith('GITHUB_WEBHOOK_SECRET is not set. Cannot verify GitHub signature.');
    });
    
    it('GitHub: should return 401 if signature algorithm is not sha256', async () => {
        const request = createMockRequest('POST', '/webhook/github', mockPayload, { 
          'content-type': 'application/json',
          'X-Hub-Signature-256': 'sha1=somehash', 
          'X-GitHub-Delivery': 'test-delivery-id' 
        });
        const response = await worker.fetch(request, env, mockExecutionContext);
        expect(response.status).toBe(401);
        const json = await response.json();
        expect(json).toEqual({ error: 'Invalid signature.' });
        expect(console.warn).toHaveBeenCalledWith('Unsupported GitHub signature algorithm: sha1');
    });

    it('GitHub: should proceed if signature is valid', async () => {
      const validSignature = await generateGithubSignature(env.GITHUB_WEBHOOK_SECRET!, rawBody);
      const request = createMockRequest('POST', '/webhook/github', mockPayload, { 
        'content-type': 'application/json',
        'X-Hub-Signature-256': validSignature,
        'X-GitHub-Delivery': 'test-delivery-id' 
      });
      (env.PROCESSED_EVENTS_KV.get as Mock).mockResolvedValue(null);
      const response = await worker.fetch(request, env, mockExecutionContext);
      expect(response.status).not.toBe(401);
      expect(response.status).toBe(200); 
      const json = await response.json() as any;
      expect(json.message).toContain('Webhook from github (Event ID: gh_delivery_test-delivery-id) received');
      expect(env.REVIEW_TASKS_QUEUE.send).toHaveBeenCalled();
    });

    it('GitLab: should return 401 if token is invalid', async () => {
      const request = createMockRequest('POST', '/webhook/gitlab', mockPayload, { 
        'content-type': 'application/json',
        'X-Gitlab-Token': 'invalid-token',
        'X-Gitlab-Event-UUID': 'test-gitlab-uuid'
      });
      (env.PROCESSED_EVENTS_KV.get as Mock).mockResolvedValue(null);
      const response = await worker.fetch(request, env, mockExecutionContext);
      expect(response.status).toBe(401);
      const json = await response.json();
      expect(json).toEqual({ error: 'Invalid signature.' });
    });

    it('GitLab: should return 401 if X-Gitlab-Token header is missing', async () => {
      const request = createMockRequest('POST', '/webhook/gitlab', mockPayload, { 
        'content-type': 'application/json',
        'X-Gitlab-Event-UUID': 'test-gitlab-uuid'
      });
      const response = await worker.fetch(request, env, mockExecutionContext);
      expect(response.status).toBe(401);
      const json = await response.json();
      expect(json).toEqual({ error: 'Invalid signature.' });
      expect(console.warn).toHaveBeenCalledWith('GitLab webhook missing X-Gitlab-Token header.');
    });

    it('GitLab: should return 401 if GITLAB_WEBHOOK_SECRET is not set', async () => {
      env.GITLAB_WEBHOOK_SECRET = undefined;
      const request = createMockRequest('POST', '/webhook/gitlab', mockPayload, { 
        'content-type': 'application/json',
        'X-Gitlab-Token': 'any-token',
        'X-Gitlab-Event-UUID': 'test-gitlab-uuid'
      });
      const response = await worker.fetch(request, env, mockExecutionContext);
      expect(response.status).toBe(401);
      const json = await response.json();
      expect(json).toEqual({ error: 'Invalid signature.' });
      expect(console.error).toHaveBeenCalledWith('GITLAB_WEBHOOK_SECRET is not set. Cannot verify GitLab token.');
    });

    it('GitLab: should proceed if token is valid', async () => {
      const request = createMockRequest('POST', '/webhook/gitlab', mockPayload, { 
        'content-type': 'application/json',
        'X-Gitlab-Token': env.GITLAB_WEBHOOK_SECRET!,
        'X-Gitlab-Event-UUID': 'test-gitlab-uuid' 
      });
      (env.PROCESSED_EVENTS_KV.get as Mock).mockResolvedValue(null);
      const response = await worker.fetch(request, env, mockExecutionContext);
      expect(response.status).not.toBe(401);
      expect(response.status).toBe(200);
      const json = await response.json() as any;
      expect(json.message).toContain('Webhook from gitlab (Event ID: gl_delivery_test-gitlab-uuid) received');
      expect(env.REVIEW_TASKS_QUEUE.send).toHaveBeenCalled();
    });
  });
  
  describe('Event Deduplication and Queueing', () => {
    const mockGithubPayload = { 
        action: 'opened', 
        pull_request: { node_id: 'pr_node_id_123', head: { sha: 'sha123' } },
        repository: { full_name: 'test/repo' } 
    };
    const rawGithubBody = JSON.stringify(mockGithubPayload);
    let validGithubSignature: string;

    const mockGitlabPayload = { 
        object_kind: 'merge_request', 
        project: { id: 789, path_with_namespace: 'gitlab/test' }, 
        object_attributes: { iid: 42, last_commit: { id: 'glsha123' } } 
    };
    const validGitlabToken = 'test-gitlab-secret'; // Matches env binding

    beforeAll(async () => {
        // This re-uses the global generateGithubSignature function
        validGithubSignature = await generateGithubSignature(getMiniflareBindings().GITHUB_WEBHOOK_SECRET!, rawGithubBody);
    });

    it('should return 202 if event is already processed (GitHub)', async () => {
      const eventId = `gh_pr_pr_node_id_123_opened_sha123`;
      (env.PROCESSED_EVENTS_KV.get as Mock).mockResolvedValue(JSON.stringify({ timestamp: Date.now(), status: "received" }));
      
      const request = createMockRequest('POST', '/webhook/github', mockGithubPayload, { 
        'content-type': 'application/json',
        'X-Hub-Signature-256': validGithubSignature,
      });

      const response = await worker.fetch(request, env, mockExecutionContext);
      expect(response.status).toBe(202);
      const json = await response.json();
      expect(json).toEqual({ message: 'Event already processed.', eventId });
      expect(env.REVIEW_TASKS_QUEUE.send).not.toHaveBeenCalled();
    });

    it('should process, store in KV, and enqueue new GitHub event', async () => {
      const eventId = `gh_pr_pr_node_id_123_opened_sha123`;
      (env.PROCESSED_EVENTS_KV.get as Mock).mockResolvedValue(null);

      const request = createMockRequest('POST', '/webhook/github', mockGithubPayload, { 
        'content-type': 'application/json',
        'X-Hub-Signature-256': validGithubSignature,
      });

      const response = await worker.fetch(request, env, mockExecutionContext);
      expect(response.status).toBe(200);
      const json = await response.json() as any;
      expect(json.message).toContain(`Webhook from github (Event ID: ${eventId}) received`);
      expect(json.eventId).toBe(eventId);

      expect(env.PROCESSED_EVENTS_KV.put).toHaveBeenCalledWith(
        eventId, 
        expect.stringContaining('"status":"received"'), 
        { expirationTtl: 3600 }
      );
      expect(env.REVIEW_TASKS_QUEUE.send).toHaveBeenCalledWith({
        source: 'github',
        eventId,
        originalPayload: mockGithubPayload,
      });
    });
    
    it('should return 202 if event is already processed (GitLab using payload ID)', async () => {
        const eventId = `gl_mr_789_42_glsha123`;
        (env.PROCESSED_EVENTS_KV.get as Mock).mockResolvedValue(JSON.stringify({ timestamp: Date.now(), status: "received" }));
        
        const request = createMockRequest('POST', '/webhook/gitlab', mockGitlabPayload, { 
          'content-type': 'application/json',
          'X-Gitlab-Token': validGitlabToken,
        });
  
        const response = await worker.fetch(request, env, mockExecutionContext);
        expect(response.status).toBe(202);
        const json = await response.json();
        expect(json).toEqual({ message: 'Event already processed.', eventId });
        expect(env.REVIEW_TASKS_QUEUE.send).not.toHaveBeenCalled();
    });

    it('should process, store in KV, and enqueue new GitLab event (using payload for ID)', async () => {
        const eventId = `gl_mr_789_42_glsha123`;
        (env.PROCESSED_EVENTS_KV.get as Mock).mockResolvedValue(null); 
  
        const request = createMockRequest('POST', '/webhook/gitlab', mockGitlabPayload, { 
          'content-type': 'application/json',
          'X-Gitlab-Token': validGitlabToken, 
        });
  
        const response = await worker.fetch(request, env, mockExecutionContext);
        expect(response.status).toBe(200);
        const json = await response.json() as any;
        expect(json.message).toContain(`Webhook from gitlab (Event ID: ${eventId}) received`);
        expect(json.eventId).toBe(eventId);
  
        expect(env.PROCESSED_EVENTS_KV.put).toHaveBeenCalledWith(
          eventId, 
          expect.stringContaining('"status":"received"'), 
          { expirationTtl: 3600 }
        );
        expect(env.REVIEW_TASKS_QUEUE.send).toHaveBeenCalledWith({
          source: 'gitlab',
          eventId,
          originalPayload: mockGitlabPayload,
        });
    });
    
    it('should use X-Gitlab-Event-UUID for event ID if present and enqueue', async () => {
        const gitlabUuid = 'definitive-gitlab-uuid';
        const eventId = `gl_delivery_${gitlabUuid}`;
        (env.PROCESSED_EVENTS_KV.get as Mock).mockResolvedValue(null);
  
        const request = createMockRequest('POST', '/webhook/gitlab', mockGitlabPayload, { 
          'content-type': 'application/json',
          'X-Gitlab-Token': validGitlabToken,
          'X-Gitlab-Event-UUID': gitlabUuid 
        });
  
        const response = await worker.fetch(request, env, mockExecutionContext);
        expect(response.status).toBe(200);
        const json = await response.json() as any;
        expect(json.eventId).toBe(eventId);
        expect(env.PROCESSED_EVENTS_KV.put).toHaveBeenCalledWith(eventId, expect.any(String), expect.any(Object));
        expect(env.REVIEW_TASKS_QUEUE.send).toHaveBeenCalledWith(expect.objectContaining({ eventId }));
    });

    it('should use X-GitHub-Delivery for event ID if other payload fields are missing and enqueue', async () => {
        const githubDeliveryId = 'definitive-github-delivery-id';
        const eventId = `gh_delivery_${githubDeliveryId}`;
        const minimalPayload = { repository: { full_name: 'test/repo' } }; 
        const rawMinimalBody = JSON.stringify(minimalPayload);
        const signatureForMinimal = await generateGithubSignature(env.GITHUB_WEBHOOK_SECRET!, rawMinimalBody);

        (env.PROCESSED_EVENTS_KV.get as Mock).mockResolvedValue(null);
  
        const request = createMockRequest('POST', '/webhook/github', minimalPayload, { 
          'content-type': 'application/json',
          'X-Hub-Signature-256': signatureForMinimal,
          'X-GitHub-Delivery': githubDeliveryId 
        });
  
        const response = await worker.fetch(request, env, mockExecutionContext);
        expect(response.status).toBe(200);
        const json = await response.json() as any;
        expect(json.eventId).toBe(eventId);
        expect(env.PROCESSED_EVENTS_KV.put).toHaveBeenCalledWith(eventId, expect.any(String), expect.any(Object));
        expect(env.REVIEW_TASKS_QUEUE.send).toHaveBeenCalledWith(expect.objectContaining({ eventId }));
    });

    it('should generate fallback gh_unknown_uuid if no specific ID parts and no delivery ID, then enqueue', async () => {
      const veryMinimalPayload = {}; 
      const rawVeryMinimalBody = JSON.stringify(veryMinimalPayload);
      const signatureForVeryMinimal = await generateGithubSignature(env.GITHUB_WEBHOOK_SECRET!, rawVeryMinimalBody);
      (env.PROCESSED_EVENTS_KV.get as Mock).mockResolvedValue(null);

      const request = createMockRequest('POST', '/webhook/github', veryMinimalPayload, { 
        'content-type': 'application/json',
        'X-Hub-Signature-256': signatureForVeryMinimal,
      });
      
      const response = await worker.fetch(request, env, mockExecutionContext);
      expect(response.status).toBe(200);
      const json = await response.json() as any;
      expect(json.eventId).toMatch(/^gh_unknown_.+/);
      expect(env.PROCESSED_EVENTS_KV.put).toHaveBeenCalledWith(expect.stringMatching(/^gh_unknown_.+/), expect.any(String), expect.any(Object));
      expect(env.REVIEW_TASKS_QUEUE.send).toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledWith('Could not determine a stable event ID for GitHub payload:', rawVeryMinimalBody);
    });
  });
});