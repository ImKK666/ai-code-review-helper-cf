import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll, type Mock } from 'vitest';
import type { ExecutionContext, MessageBatch, Queue, KVNamespace, Message } from '@cloudflare/workers-types'; 
import worker, { Env as ReviewerEnv, callLLM, postCommentsToVCS, LLMComment } from '../index';
import { setupServer } from 'msw/node';
import { HttpResponse, http } from 'msw';

interface TestWebhookQueueMessage {
  source: 'github' | 'gitlab'; 
  eventId: string;
  originalPayload: any; 
  reviewType?: 'detailed' | 'general'; 
  filesToReview?: Array<{ path: string; content?: string; diff?: string }>;
}

interface UnsupportedSourceWebhookQueueMessage extends Omit<TestWebhookQueueMessage, 'source'> {
    source: string; 
}


const getMiniflareBindings = (): ReviewerEnv => ({
  REVIEW_TASKS_QUEUE: { 
    send: vi.fn(),
    sendBatch: vi.fn(),
  } as any, 
  REVIEW_RESULTS_KV: {
    put: vi.fn(),
    get: vi.fn(),
  } as any, 
  LLM_API_KEY: 'test_llm_api_key',
  GITHUB_TOKEN: 'test_github_token', 
  GITLAB_TOKEN: 'test_gitlab_token', 
  LLM_ENDPOINT: 'https://api.openai.com/v1/chat/completions', 
  LLM_MODEL_NAME: 'gpt-test-model', 
});

const server = setupServer();

describe('worker-reviewer', () => {
  let env: ReviewerEnv;
  let mockExecutionContext: ExecutionContext; 

beforeAll(() => {
    server.listen({ onUnhandledRequest: 'error' });
});

afterAll(() => {
    server.close();
});

beforeEach(() => {
    env = getMiniflareBindings();
    mockExecutionContext = {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
        props: {},
    } as ExecutionContext;

    // server.listen({ onUnhandledRequest: 'error' }); // Moved to beforeAll
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});


    vi.clearAllMocks();
    (env.REVIEW_RESULTS_KV.put as Mock).mockReset();
    (env.REVIEW_RESULTS_KV.get as Mock).mockReset();
    if (env.REVIEW_TASKS_QUEUE && (env.REVIEW_TASKS_QUEUE.send as Mock)?.mockReset) {
        (env.REVIEW_TASKS_QUEUE.send as Mock).mockReset();
    }
    if ((console.log as Mock).mockReset) (console.log as Mock).mockReset();
    if ((console.warn as Mock).mockReset) (console.warn as Mock).mockReset();
    if ((console.error as Mock).mockReset) (console.error as Mock).mockReset();
});

afterEach(() => {
    server.resetHandlers();
    // server.close(); // Moved to afterAll
    vi.restoreAllMocks();
});

  describe('Queue Message Processing', () => {
    const mockGithubMessageBodyBase: Omit<TestWebhookQueueMessage, 'filesToReview' | 'eventId'> = { 
      source: 'github',
      originalPayload: {
        repository: {
          id: 12345,
          full_name: 'test-owner/test-repo',
          owner: { login: 'test-owner' }, 
          name: 'test-repo', 
          default_branch: 'main',
        },
        pull_request: {
          id: 67890,
          number: 123,
          html_url: 'https://github.com/test-owner/test-repo/pull/123',
          head: { sha: 'test-sha' },
          diff_url: 'https://github.com/test-owner/test-repo/pull/123.diff',
          comments_url: 'https://api.github.com/repos/test-owner/test-repo/issues/123/comments', 
        },
      },
      reviewType: 'detailed',
    };

    const mockGithubMessageWithFiles: TestWebhookQueueMessage = {
        ...mockGithubMessageBodyBase,
        eventId: 'gh_delivery_with_files',
        filesToReview: [{ path: 'file.txt', diff: 'diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old line\n+new line'}]
    };
    
    const mockGithubMessageNoFiles: TestWebhookQueueMessage = {
        ...mockGithubMessageBodyBase,
        eventId: 'gh_delivery_no_files',
        filesToReview: [] 
    };

    const mockGitlabMessageBodyBase: Omit<TestWebhookQueueMessage, 'filesToReview' | 'eventId' | 'source'> & {source: 'gitlab'} = {
        source: 'gitlab',
        originalPayload: {
          project: {
            id: 789,
            path_with_namespace: 'test-group/test-project',
            web_url: 'https://gitlab.com/test-group/test-project',
            default_branch: 'main',
          },
          object_attributes: {
            id: 101,
            iid: 42, 
            target_project_id: 789,
            last_commit: { id: 'gitlab-test-sha' },
            action: 'open',
          },
          object_kind: 'merge_request',
        },
        reviewType: 'detailed',
    };

    const mockGitlabMessageWithFileComment: TestWebhookQueueMessage = {
        ...mockGitlabMessageBodyBase,
        eventId: 'gl_delivery_file_comment',
        filesToReview: [{ path: 'main.py', diff: 'diff --git a/main.py b/main.py\n--- a/main.py\n+++ b/main.py\n@@ -1 +1 @@\n-print("hello")\n+print("hello world")'}]
    };

    const mockGitlabMessageForMRComment: TestWebhookQueueMessage = {
        ...mockGitlabMessageBodyBase,
        eventId: 'gl_delivery_mr_comment',
        filesToReview: [] 
    };


    const createMockMessage = (id: string, body: TestWebhookQueueMessage | UnsupportedSourceWebhookQueueMessage): Message<any> => ({
        id,
        timestamp: new Date(),
        body,
        ack: vi.fn(),
        retry: vi.fn(),
        attempts: 1, 
    });

    it('should successfully process a GitHub message with files, call LLM, and post review', async () => {
      server.use(
        http.post(env.LLM_ENDPOINT, async () => {
          return HttpResponse.json({ 
            choices: [{ message: { content: JSON.stringify({ 
                success: true,
                comments: [{ filePath: 'file.txt', lineNumber: 1, comment: 'Mocked LLM review comment for GitHub.' }],
                summary: 'Overall good changes for GitHub.'
            }) } }],
          });
        }),
        http.post(mockGithubMessageWithFiles.originalPayload.pull_request!.comments_url, async () => {
          return HttpResponse.json({ id: 1, body: 'Mocked LLM review comment for GitHub.' }, { status: 201 });
        })
      );
      
      const mockMessage = createMockMessage('gh-1', mockGithubMessageWithFiles);
      const batch: MessageBatch<TestWebhookQueueMessage> = { messages: [mockMessage], queue: 'test-queue', ackAll: vi.fn(), retryAll: vi.fn() };
      await worker.queue!(batch as MessageBatch<any>, env, mockExecutionContext);

      expect(mockMessage.ack).toHaveBeenCalled();
      const expectedSuccessKey = `review:github:test-owner/test-repo:123:${mockGithubMessageWithFiles.eventId}`;
      expect(env.REVIEW_RESULTS_KV.put).toHaveBeenCalledWith(
        expectedSuccessKey, 
        expect.stringContaining('"status":"completed"'), 
        expect.objectContaining({ metadata: { status: "completed", timestamp: expect.any(String) } })
      );
    });

    it('should handle LLM API failure (retryable) for GitHub message and store failure outcome', async () => {
      server.use(
        http.post(env.LLM_ENDPOINT, async () => { 
          return HttpResponse.json({ error: { message: 'LLM API error - retryable', type: 'server_error'} }, { status: 500 });
        })
      );

      const mockMessage = createMockMessage('gh-llm-retry-fail', mockGithubMessageWithFiles);
      const batch: MessageBatch<TestWebhookQueueMessage> = { messages: [mockMessage], queue: 'test-queue', ackAll: vi.fn(), retryAll: vi.fn() };
      await expect(worker.queue!(batch as MessageBatch<any>, env, mockExecutionContext)).rejects.toThrow(Error); 
      expect(mockMessage.ack).not.toHaveBeenCalled(); 
      const expectedErrorKey = `review:${mockGithubMessageWithFiles.eventId}:${mockGithubMessageWithFiles.originalPayload.repository.full_name}:${mockGithubMessageWithFiles.originalPayload.pull_request.number}:${mockGithubMessageWithFiles.eventId}`;
      expect(env.REVIEW_RESULTS_KV.put).toHaveBeenCalledWith(
        expectedErrorKey,
        expect.stringContaining('"status":"failed"'), 
        expect.objectContaining({ metadata: { status: "failed", timestamp: expect.any(String) } })
      );
    });

    it('should successfully process a GitLab message with file comment, call LLM, and post review', async () => {
        server.use(
          http.post(env.LLM_ENDPOINT, async () => {
            return HttpResponse.json({ 
              choices: [{ message: { content: JSON.stringify({ 
                  success: true,
                  comments: [{ filePath: 'main.py', lineNumber: 1, comment: 'Mocked LLM review comment for GitLab.' }],
                  summary: 'Overall good changes for GitLab.'
              }) } }],
            });
          }),
          http.post(`https://gitlab.com/api/v4/projects/${mockGitlabMessageWithFileComment.originalPayload.project.id}/merge_requests/${mockGitlabMessageWithFileComment.originalPayload.object_attributes.iid}/notes`, async (req) => {
            const requestBody = await req.request.json() as any;
            expect(requestBody.position).toBeDefined(); 
            return HttpResponse.json({ id: 1, body: 'Mocked LLM review comment for GitLab.' }, { status: 201 });
          })
        );
        
        const mockMessage = createMockMessage('gl-file-comment', mockGitlabMessageWithFileComment);
        const batch: MessageBatch<TestWebhookQueueMessage> = { messages: [mockMessage], queue: 'test-queue', ackAll: vi.fn(), retryAll: vi.fn() };
        await worker.queue!(batch as MessageBatch<any>, env, mockExecutionContext);
  
        expect(mockMessage.ack).toHaveBeenCalled();
        const expectedSuccessKey = `review:gitlab:test-group/test-project:42:${mockGitlabMessageWithFileComment.eventId}`;
        expect(env.REVIEW_RESULTS_KV.put).toHaveBeenCalledWith(
          expectedSuccessKey, 
          expect.stringContaining('"status":"completed"'), 
          expect.objectContaining({ metadata: { status: "completed", timestamp: expect.any(String) } })
        );
    });

    it('should successfully process a GitLab message for MR-level comment (no line number)', async () => {
        server.use(
          http.post(env.LLM_ENDPOINT, async () => {
            return HttpResponse.json({ 
              choices: [{ message: { content: JSON.stringify({ 
                  success: true,
                  comments: [{ comment: 'This is an MR-level comment for GitLab.' }], 
                  summary: 'General MR feedback for GitLab.'
              }) } }],
            });
          }),
          http.post(`https://gitlab.com/api/v4/projects/${mockGitlabMessageForMRComment.originalPayload.project.id}/merge_requests/${mockGitlabMessageForMRComment.originalPayload.object_attributes.iid}/notes`, async (req) => {
            const requestBody = await req.request.json() as any;
            expect(requestBody.position).toBeUndefined(); 
            return HttpResponse.json({ id: 2, body: 'MR-level comment posted.' }, { status: 201 });
          })
        );
        
        const mockMessage = createMockMessage('gl-mr-comment', mockGitlabMessageForMRComment);
        const batch: MessageBatch<TestWebhookQueueMessage> = { messages: [mockMessage], queue: 'test-queue', ackAll: vi.fn(), retryAll: vi.fn() };
        await worker.queue!(batch as MessageBatch<any>, env, mockExecutionContext);
  
        expect(mockMessage.ack).toHaveBeenCalled();
        const expectedSuccessKey = `review:gitlab:test-group/test-project:42:${mockGitlabMessageForMRComment.eventId}`;
        expect(env.REVIEW_RESULTS_KV.put).toHaveBeenCalledWith(
          expectedSuccessKey, 
          expect.stringContaining('"status":"completed"'), 
          expect.objectContaining({ metadata: { status: "completed", timestamp: expect.any(String) } })
        );
    });


    it('should handle GitHub API failure when posting comments and store outcome', async () => {
        server.use(
          http.post(env.LLM_ENDPOINT, async () => { 
            return HttpResponse.json({ 
              choices: [{ message: { content: JSON.stringify({ 
                  success: true,
                  comments: [{ filePath: 'file.txt', lineNumber: 1, comment: 'A valid comment.' }],
                  summary: 'LLM review complete.'
              }) } }],
            });
          }),
          http.post(mockGithubMessageWithFiles.originalPayload.pull_request!.comments_url, async () => { 
            return HttpResponse.json({ message: 'GitHub API error' }, { status: 500 });
          })
        );
  
        const mockMessage = createMockMessage('gh-vcs-fail', mockGithubMessageWithFiles);
        const batch: MessageBatch<TestWebhookQueueMessage> = { messages: [mockMessage], queue: 'test-queue', ackAll: vi.fn(), retryAll: vi.fn() };
        await worker.queue!(batch as MessageBatch<any>, env, mockExecutionContext);
  
        expect(mockMessage.ack).toHaveBeenCalled(); 
        const expectedKey = `review:github:test-owner/test-repo:123:${mockGithubMessageWithFiles.eventId}`;
        expect(env.REVIEW_RESULTS_KV.put).toHaveBeenCalledWith(
          expectedKey,
          expect.stringContaining('"status":"completed"'), 
          expect.objectContaining({ metadata: { status: "completed", timestamp: expect.any(String) } })
        );
    });

    it('should handle GitLab API failure when posting comments and store outcome', async () => {
        server.use(
          http.post(env.LLM_ENDPOINT, async () => { 
            return HttpResponse.json({ 
              choices: [{ message: { content: JSON.stringify({ 
                  success: true,
                  comments: [{ filePath: 'main.py', lineNumber: 1, comment: 'A valid GitLab comment.' }],
                  summary: 'LLM review complete for GitLab.'
              }) } }],
            });
          }),
          http.post(`https://gitlab.com/api/v4/projects/${mockGitlabMessageWithFileComment.originalPayload.project.id}/merge_requests/${mockGitlabMessageWithFileComment.originalPayload.object_attributes.iid}/notes`, async () => { 
            return HttpResponse.json({ message: 'GitLab API error' }, { status: 500 });
          })
        );
  
        const mockMessage = createMockMessage('gl-vcs-fail', mockGitlabMessageWithFileComment); 
        const batch: MessageBatch<TestWebhookQueueMessage> = { messages: [mockMessage], queue: 'test-queue', ackAll: vi.fn(), retryAll: vi.fn() };
        await worker.queue!(batch as MessageBatch<any>, env, mockExecutionContext);
  
        expect(mockMessage.ack).toHaveBeenCalled(); 
        const expectedKey = `review:gitlab:test-group/test-project:42:${mockGitlabMessageWithFileComment.eventId}`;
        expect(env.REVIEW_RESULTS_KV.put).toHaveBeenCalledWith(
          expectedKey,
          expect.stringContaining('"status":"completed"'), 
          expect.objectContaining({ metadata: { status: "completed", timestamp: expect.any(String) } })
        );
    });

    it('should handle LLM API failure (non-retryable) and store "error_calling_llm" outcome', async () => {
        server.use(
          http.post(env.LLM_ENDPOINT, async () => { 
            return HttpResponse.json({ error: { message: 'LLM API error - non-retryable', type: 'invalid_request_error'} }, { status: 400 });
          })
        );
  
        const mockMessage = createMockMessage('gh-llm-nonretry-fail', mockGithubMessageWithFiles);
        const batch: MessageBatch<TestWebhookQueueMessage> = { messages: [mockMessage], queue: 'test-queue', ackAll: vi.fn(), retryAll: vi.fn() };
        
        await worker.queue!(batch as MessageBatch<any>, env, mockExecutionContext);
        
        expect(mockMessage.ack).toHaveBeenCalled(); 
        const expectedOutcomeKey = `review:github:test-owner/test-repo:123:${mockGithubMessageWithFiles.eventId}`;
        expect(env.REVIEW_RESULTS_KV.put).toHaveBeenCalledWith(
          expectedOutcomeKey,
          expect.stringContaining('"status":"error_calling_llm"'), 
          expect.objectContaining({ metadata: { status: "error_calling_llm", timestamp: expect.any(String) } })
        );
    });

    it('should process message with no filesToReview, log warning, and call LLM for general review', async () => {
        server.use(
          http.post(env.LLM_ENDPOINT, async (req) => {
            const body = await req.request.json() as any;
            expect(body.messages[1].content).toContain("No specific file diffs provided. Please provide a general review.");
            return HttpResponse.json({ 
              choices: [{ message: { content: JSON.stringify({ 
                  success: true,
                  summary: 'General review complete, no specific files.'
              }) } }],
            });
          })
        );
  
        const mockMessage = createMockMessage('gh-no-files', mockGithubMessageNoFiles);
        const batch: MessageBatch<TestWebhookQueueMessage> = { messages: [mockMessage], queue: 'test-queue', ackAll: vi.fn(), retryAll: vi.fn() };
        await worker.queue!(batch as MessageBatch<any>, env, mockExecutionContext);
  
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`Task ${mockMessage.id} (Event: ${mockGithubMessageNoFiles.eventId}) has no filesToReview.`));
        expect(mockMessage.ack).toHaveBeenCalled();
        const expectedKey = `review:github:test-owner/test-repo:123:${mockGithubMessageNoFiles.eventId}`;
        
        expect(env.REVIEW_RESULTS_KV.put).toHaveBeenCalledWith(
          expectedKey,
          expect.stringContaining('"status":"completed"'), 
          expect.objectContaining({ metadata: { status: "completed", timestamp: expect.any(String) } })
        );
        const putCallArgs = (env.REVIEW_RESULTS_KV.put as Mock).mock.calls[0];
        expect(putCallArgs[1]).toContain('"summary":"General review complete, no specific files."');
    });

    it('should process message where LLM returns no comments and not attempt to post to VCS', async () => {
        server.use(
          http.post(env.LLM_ENDPOINT, async () => {
            return HttpResponse.json({ 
              choices: [{ message: { content: JSON.stringify({ 
                  success: true,
                  comments: [], 
                  summary: 'A good PR with no specific comments needed.'
              }) } }],
            });
          })
        );
  
        const mockMessage = createMockMessage('gh-no-llm-comments', mockGithubMessageWithFiles);
        const batch: MessageBatch<TestWebhookQueueMessage> = { messages: [mockMessage], queue: 'test-queue', ackAll: vi.fn(), retryAll: vi.fn() };
                
        await worker.queue!(batch as MessageBatch<any>, env, mockExecutionContext);
  
        expect(mockMessage.ack).toHaveBeenCalled();
        const expectedKey = `review:github:test-owner/test-repo:123:${mockGithubMessageWithFiles.eventId}`;
        expect(env.REVIEW_RESULTS_KV.put).toHaveBeenCalledWith(
          expectedKey,
          expect.stringContaining('"status":"completed"'),
          expect.objectContaining({ metadata: { status: "completed", timestamp: expect.any(String) } })
        );
        const putCallArgs = (env.REVIEW_RESULTS_KV.put as Mock).mock.calls[0];
        expect(putCallArgs[1]).toContain('"summary":"A good PR with no specific comments needed."');
        expect(putCallArgs[1]).not.toContain('"comments":[{'); 
    });

    it('should handle unsupported VCS source, log error, and store outcome reflecting current behavior', async () => {
        const unsupportedSourceMessageBody: UnsupportedSourceWebhookQueueMessage = {
          originalPayload: mockGithubMessageWithFiles.originalPayload,
          reviewType: mockGithubMessageWithFiles.reviewType,
          filesToReview: mockGithubMessageWithFiles.filesToReview,
          source: 'unsupported_vcs', 
          eventId: 'gh-unsupported-src',
        };
    
        server.use(
          http.post(env.LLM_ENDPOINT, async () => {
            return HttpResponse.json({
              choices: [{ message: { content: JSON.stringify({
                  success: true, 
                  comments: [{ filePath: 'file.txt', lineNumber: 1, comment: 'A comment that should not be posted.' }],
                  summary: 'LLM review done, but VCS is unsupported.'
              }) } }],
            });
          })
        );
    
        const mockMessage = createMockMessage('unsupported-1', unsupportedSourceMessageBody);
        const batch: MessageBatch<any> = { messages: [mockMessage], queue: 'test-queue', ackAll: vi.fn(), retryAll: vi.fn() };
        
        await worker.queue!(batch, env, mockExecutionContext);
    
        expect(mockMessage.ack).toHaveBeenCalled(); 
        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining(`Unsupported VCS or missing details for task ${unsupportedSourceMessageBody.eventId}`)
        );
        
        const expectedKey = `review:${unsupportedSourceMessageBody.eventId}:${unsupportedSourceMessageBody.originalPayload.repository.full_name}:${unsupportedSourceMessageBody.originalPayload.pull_request.number}:${unsupportedSourceMessageBody.eventId}`;
        
        expect(env.REVIEW_RESULTS_KV.put).toHaveBeenCalledWith(
          expectedKey,
          expect.stringMatching(/"status":"completed".*"error":"Outer catch: Unsupported VCS: unsupported_vcs"/s),
          expect.objectContaining({ metadata: { status: "completed", timestamp: expect.any(String) } })
        );
    });

    it('should handle network error during VCS post and store outcome', async () => {
        server.use(
          http.post(env.LLM_ENDPOINT, async () => { 
            return HttpResponse.json({ 
              choices: [{ message: { content: JSON.stringify({ 
                  success: true,
                  comments: [{ filePath: 'file.txt', lineNumber: 1, comment: 'A valid comment.' }],
                  summary: 'LLM review complete.'
              }) } }],
            });
          }),
          http.post(mockGithubMessageWithFiles.originalPayload.pull_request!.comments_url, () => {
            return HttpResponse.error(); // Simulates a network-level error
          })
        );
  
        const mockMessage = createMockMessage('gh-network-error', mockGithubMessageWithFiles);
        const batch: MessageBatch<TestWebhookQueueMessage> = { messages: [mockMessage], queue: 'test-queue', ackAll: vi.fn(), retryAll: vi.fn() };
        
        await worker.queue!(batch as MessageBatch<any>, env, mockExecutionContext);
  
        expect(mockMessage.ack).toHaveBeenCalled(); 
        // The actual log format from src/index.ts:325 is "Error during VCS post for ${task.eventId}, file ${comment.filePath}: ${error.message}"
        // When HttpResponse.error() is used, the error message caught by fetch is typically "Failed to fetch"
        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining(`Error during VCS post for ${mockGithubMessageWithFiles.eventId}, file file.txt: Failed to fetch`)
        );
        
        const expectedKey = `review:github:test-owner/test-repo:123:${mockGithubMessageWithFiles.eventId}`;
        expect(env.REVIEW_RESULTS_KV.put).toHaveBeenCalledWith(
          expectedKey,
          expect.stringContaining('"status":"completed"'), 
          expect.objectContaining({ metadata: { status: "completed", timestamp: expect.any(String) } })
        );
        const putCallArgs = (env.REVIEW_RESULTS_KV.put as Mock).mock.calls[0];
        expect(putCallArgs[1]).not.toContain('"error":'); 
      });

  });
  
  describe('postCommentsToVCS', () => {
      let env: ReviewerEnv;
      let mockTask: any;
  
      beforeEach(() => {
          env = getMiniflareBindings();
          mockTask = {
              source: 'github',
              eventId: 'test-event-id',
              repository: { fullName: 'test-owner/test-repo', id: 123, defaultBranch: 'main' },
              pullRequest: { id: 456, number: 1, headSha: 'test-sha', diffUrl: 'test-diff-url', commentsUrl: 'https://api.github.com/repos/test-owner/test-repo/issues/1/comments' },
              reviewType: 'detailed',
              filesToReview: [],
          };
          // server.listen({ onUnhandledRequest: 'error' }); // Moved to beforeAll
          vi.spyOn(console, 'log').mockImplementation(() => {});
          vi.spyOn(console, 'error').mockImplementation(() => {});
          vi.clearAllMocks();
      });
  
      afterEach(() => {
          server.resetHandlers();
          // server.close(); // Moved to afterAll
          vi.restoreAllMocks();
      });
  
      it('should post comments to GitHub successfully', async () => {
          const comments = [{ filePath: 'file1.txt', lineNumber: 5, comment: 'Comment 1' }];
          server.use(
              http.post(mockTask.pullRequest.commentsUrl, async ({ request }) => {
                  const body: any = await request.json(); // Cast to any
                  expect(body.body).toBe('Comment 1');
                  expect(body.commit_id).toBe('test-sha');
                  expect(body.path).toBe('file1.txt');
                  expect(body.line).toBe(5);
                  return HttpResponse.json({ id: 1 }, { status: 201 });
              })
          );
  
          await postCommentsToVCS(mockTask, comments, env);
  
          expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Posting 1 comments for task test-event-id to github'));
          expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Successfully posted comment to github for test-event-id, file file1.txt'));
          expect(console.error).not.toHaveBeenCalled();
      });
  
      it('should handle GitHub API error when posting comments', async () => {
          const comments = [{ filePath: 'file1.txt', lineNumber: 5, comment: 'Comment 1' }];
          server.use(
              http.post(mockTask.pullRequest.commentsUrl, () => {
                  return HttpResponse.json({ message: 'GitHub API error' }, { status: 500 });
              })
          );
  
          await postCommentsToVCS(mockTask, comments, env);
  
          expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Posting 1 comments for task test-event-id to github'));
          expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to post comment to github for test-event-id, file file1.txt: 500 GitHub API error'));
      });
  
      it('should handle network error during GitHub post', async () => {
          const comments = [{ filePath: 'file1.txt', lineNumber: 5, comment: 'Comment 1' }];
          server.use(
              http.post(mockTask.pullRequest.commentsUrl, () => {
                  return HttpResponse.error(); // Simulates a network error
              })
          );
  
          await postCommentsToVCS(mockTask, comments, env);
  
          expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Posting 1 comments for task test-event-id to github'));
          expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Error during VCS post for test-event-id, file file1.txt: Failed to fetch'));
      });
  
      it('should post comments to GitLab successfully (file comment)', async () => {
          mockTask.source = 'gitlab';
          mockTask.pullRequest = undefined;
          mockTask.mergeRequest = { id: 789, iid: 42, projectId: 987, headSha: 'gitlab-sha', diffUrl: 'test-gitlab-diff-url', notesUrl: 'https://gitlab.com/api/v4/projects/987/merge_requests/42/notes' };
          const comments = [{ filePath: 'file.py', lineNumber: 10, comment: 'GitLab Comment 1' }];
  
          server.use(
              http.post(mockTask.mergeRequest.notesUrl, async ({ request }) => {
                  const body: any = await request.json(); // Cast to any
                  expect(body.body).toBe('GitLab Comment 1');
                  expect(body.position).toBeDefined();
                  expect(body.position.position_type).toBe('text');
                  expect(body.position.new_line).toBe(10);
                  expect(body.position.new_path).toBe('file.py');
                  return HttpResponse.json({ id: 1 }, { status: 201 });
              })
          );
  
          await postCommentsToVCS(mockTask, comments, env);
  
          expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Posting 1 comments for task test-event-id to gitlab'));
          expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Successfully posted comment to gitlab for test-event-id, file file.py'));
          expect(console.error).not.toHaveBeenCalled();
      });
  
      it('should post comments to GitLab successfully (MR comment)', async () => {
          mockTask.source = 'gitlab';
          mockTask.pullRequest = undefined;
          mockTask.mergeRequest = { id: 789, iid: 42, projectId: 987, headSha: 'gitlab-sha', diffUrl: 'test-gitlab-diff-url', notesUrl: 'https://gitlab.com/api/v4/projects/987/merge_requests/42/notes' };
          const comments: LLMComment[] = [{ filePath: '', comment: 'GitLab MR Comment' }]; // No filePath or lineNumber, add filePath for type compatibility
  
          server.use(
              http.post(mockTask.mergeRequest.notesUrl, async ({ request }) => {
                  const body: any = await request.json(); // Cast to any
                  expect(body.body).toBe('GitLab MR Comment');
                  expect(body.position).toBeUndefined(); // Should not have position for MR comment
                  return HttpResponse.json({ id: 1 }, { status: 201 });
              })
          );
  
          await postCommentsToVCS(mockTask, comments, env);
  
          expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Posting 1 comments for task test-event-id to gitlab'));
          expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Successfully posted comment to gitlab for test-event-id, file undefined')); // filePath is undefined
          expect(console.error).not.toHaveBeenCalled();
      });
  
  
      it('should handle GitLab API error when posting comments', async () => {
          mockTask.source = 'gitlab';
          mockTask.pullRequest = undefined;
          mockTask.mergeRequest = { id: 789, iid: 42, projectId: 987, headSha: 'gitlab-sha', diffUrl: 'test-gitlab-diff-url', notesUrl: 'https://gitlab.com/api/v4/projects/987/merge_requests/42/notes' };
          const comments = [{ filePath: 'file.py', lineNumber: 10, comment: 'GitLab Comment 1' }];
  
          server.use(
              http.post(mockTask.mergeRequest.notesUrl, () => {
                  return HttpResponse.json({ message: 'GitLab API error' }, { status: 500 });
              })
          );
  
          await postCommentsToVCS(mockTask, comments, env);
  
          expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Posting 1 comments for task test-event-id to gitlab'));
          expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to post comment to gitlab for test-event-id, file file.py: 500 GitLab API error'));
      });
  
      it('should handle network error during GitLab post', async () => {
          mockTask.source = 'gitlab';
          mockTask.pullRequest = undefined;
          mockTask.mergeRequest = { id: 789, iid: 42, projectId: 987, headSha: 'gitlab-sha', diffUrl: 'test-gitlab-diff-url', notesUrl: 'https://gitlab.com/api/v4/projects/987/merge_requests/42/notes' };
          const comments = [{ filePath: 'file.py', lineNumber: 10, comment: 'GitLab Comment 1' }];
  
          server.use(
              http.post(mockTask.mergeRequest.notesUrl, () => {
                  return HttpResponse.error(); // Simulates a network error
              })
          );
  
          await postCommentsToVCS(mockTask, comments, env);
  
          expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Posting 1 comments for task test-event-id to gitlab'));
          expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Error during VCS post for test-event-id, file file.py: Failed to fetch'));
      });
  
      it('should not post comments if comments array is empty', async () => {
          const comments: LLMComment[] = [];
          const fetchSpy = vi.spyOn(globalThis, 'fetch');
  
          await postCommentsToVCS(mockTask, comments, env);
  
          expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No comments to post for task test-event-id.'));
          expect(fetchSpy).not.toHaveBeenCalled();
          expect(console.error).not.toHaveBeenCalled();
      });
  
      it('should throw error for unsupported VCS source', async () => {
          mockTask.source = 'unsupported_vcs';
          const comments: LLMComment[] = [{ filePath: '', comment: 'Should not be posted' }]; // Add filePath for type compatibility
  
          await expect(postCommentsToVCS(mockTask, comments, env)).rejects.toThrow('Unsupported VCS: unsupported_vcs');
          expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Unsupported VCS or missing details for task test-event-id: unsupported_vcs'));
      });
  
      it('should handle multiple comments, posting them sequentially', async () => {
          const comments = [
              { filePath: 'file1.txt', lineNumber: 5, comment: 'Comment 1' },
              { filePath: 'file2.txt', lineNumber: 10, comment: 'Comment 2' },
          ];
          const fetchSpy = vi.spyOn(globalThis, 'fetch');
  
          server.use(
              http.post(mockTask.pullRequest.commentsUrl, async ({ request }) => {
                  const body: any = await request.json(); // Cast to any
                  if (body.path === 'file1.txt') {
                      return HttpResponse.json({ id: 1 }, { status: 201 });
                  } else if (body.path === 'file2.txt') {
                      return HttpResponse.json({ id: 2 }, { status: 201 });
                  }
                  return HttpResponse.error(); // Should not reach here
              })
          );
  
          await postCommentsToVCS(mockTask, comments, env);
  
          expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Posting 2 comments for task test-event-id to github'));
          expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Successfully posted comment to github for test-event-id, file file1.txt'));
          expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Successfully posted comment to github for test-event-id, file file2.txt'));
          expect(fetchSpy).toHaveBeenCalledTimes(2); // Ensure fetch is called for each comment
          expect(console.error).not.toHaveBeenCalled();
      });

      it('should handle comments with special characters in GitHub', async () => {
          const commentsWithSpecialChars = [
              { filePath: 'file1.txt', lineNumber: 5, comment: 'Comment with 特殊字符 and emoji 🚀' }
          ];
          server.use(
              http.post(mockTask.pullRequest.commentsUrl, async ({ request }) => {
                  const body: any = await request.json();
                  expect(body.body).toBe('Comment with 特殊字符 and emoji 🚀');
                  return HttpResponse.json({ id: 1 }, { status: 201 });
              })
          );
  
          await postCommentsToVCS(mockTask, commentsWithSpecialChars, env);
  
          expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Successfully posted comment to github'));
          expect(console.error).not.toHaveBeenCalled();
      });

      it('should handle very long comments in GitHub', async () => {
          const longComment = 'A'.repeat(2000); // Create a 2000 character comment
          const commentsWithLongText = [
              { filePath: 'file1.txt', lineNumber: 5, comment: longComment }
          ];
          server.use(
              http.post(mockTask.pullRequest.commentsUrl, async ({ request }) => {
                  const body: any = await request.json();
                  expect(body.body.length).toBe(2000);
                  return HttpResponse.json({ id: 1 }, { status: 201 });
              })
          );
  
          await postCommentsToVCS(mockTask, commentsWithLongText, env);
  
          expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Successfully posted comment to github'));
          expect(console.error).not.toHaveBeenCalled();
      });

      it('should handle special characters in GitLab comments', async () => {
          mockTask.source = 'gitlab';
          mockTask.pullRequest = undefined;
          mockTask.mergeRequest = { id: 789, iid: 42, projectId: 987, headSha: 'gitlab-sha', diffUrl: 'test-gitlab-diff-url', notesUrl: 'https://gitlab.com/api/v4/projects/987/merge_requests/42/notes' };
          const commentsWithSpecialChars = [
              { filePath: 'file.py', lineNumber: 10, comment: 'GitLab Comment with 特殊字符 and emoji 🔥' }
          ];
  
          server.use(
              http.post(mockTask.mergeRequest.notesUrl, async ({ request }) => {
                  const body: any = await request.json();
                  expect(body.body).toBe('GitLab Comment with 特殊字符 and emoji 🔥');
                  expect(body.position).toBeDefined();
                  return HttpResponse.json({ id: 1 }, { status: 201 });
              })
          );
  
          await postCommentsToVCS(mockTask, commentsWithSpecialChars, env);
  
          expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Successfully posted comment to gitlab'));
          expect(console.error).not.toHaveBeenCalled();
      });

      it('should handle very long comments in GitLab', async () => {
          mockTask.source = 'gitlab';
          mockTask.pullRequest = undefined;
          mockTask.mergeRequest = { id: 789, iid: 42, projectId: 987, headSha: 'gitlab-sha', diffUrl: 'test-gitlab-diff-url', notesUrl: 'https://gitlab.com/api/v4/projects/987/merge_requests/42/notes' };
          const longComment = 'A'.repeat(2000); // Create a 2000 character comment
          const commentsWithLongText = [
              { filePath: 'file.py', lineNumber: 10, comment: longComment }
          ];
  
          server.use(
              http.post(mockTask.mergeRequest.notesUrl, async ({ request }) => {
                  const body: any = await request.json();
                  expect(body.body.length).toBe(2000);
                  expect(body.position).toBeDefined();
                  return HttpResponse.json({ id: 1 }, { status: 201 });
              })
          );
  
          await postCommentsToVCS(mockTask, commentsWithLongText, env);
  
          expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Successfully posted comment to gitlab'));
          expect(console.error).not.toHaveBeenCalled();
      });
  });
  
  describe('callLLM', () => {
      let env: ReviewerEnv;
      let mockTask: any;
  
      beforeEach(() => {
          env = getMiniflareBindings();
          mockTask = {
              source: 'github',
              eventId: 'test-llm-event-id',
              repository: { fullName: 'test-owner/test-repo', id: 123, defaultBranch: 'main' },
              pullRequest: { id: 456, number: 1, headSha: 'test-sha', diffUrl: 'test-diff-url', commentsUrl: 'test-comments-url' },
              reviewType: 'detailed',
              filesToReview: [{ path: 'file.txt', diff: 'diff content' }],
          };
          // server.listen({ onUnhandledRequest: 'error' }); // Moved to beforeAll
          vi.spyOn(console, 'log').mockImplementation(() => {});
          vi.spyOn(console, 'error').mockImplementation(() => {});
          vi.clearAllMocks();
      });
  
      afterEach(() => {
          server.resetHandlers();
          // server.close(); // Moved to afterAll
          vi.restoreAllMocks();
      });
  
      it('should call LLM API successfully and return parsed response', async () => {
          const mockLlmResponse = {
              success: true,
              comments: [{ filePath: 'file.txt', lineNumber: 1, comment: 'LLM comment' }],
              summary: 'LLM summary',
          };
          server.use(
              http.post(env.LLM_ENDPOINT, () => {
                  return HttpResponse.json({
                      choices: [{ message: { content: JSON.stringify(mockLlmResponse) } }],
                  });
              })
          );
  
          const result = await callLLM(mockTask, env);
  
          expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Calling LLM for task: test-llm-event-id, type: detailed'));
          expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Sending to LLM:'));
          expect(result).toEqual({ ...mockLlmResponse, rawResponse: expect.any(Object), isRetryable: false });
          expect(console.error).not.toHaveBeenCalled();
      });
  
      it('should handle LLM API non-retryable error (e.g., 400)', async () => {
          server.use(
              http.post(env.LLM_ENDPOINT, () => {
                  return HttpResponse.json({ error: { message: 'Invalid request' } }, { status: 400 });
              })
          );
  
          const result = await callLLM(mockTask, env);
  
          expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Calling LLM for task: test-llm-event-id, type: detailed'));
          // Check the first argument of console.error
          expect(console.error).toHaveBeenCalledWith(expect.stringContaining('LLM API request failed with status 400: {"error":{"message":"Invalid request"}}'));
          expect(result).toEqual({
              success: false,
              error: expect.stringContaining('LLM API error 400: {"error":{"message":"Invalid request"}}'),
              rawResponse: expect.stringContaining('{"error":{"message":"Invalid request"}}'),
              isRetryable: false,
          });
      });
  
      it('should handle LLM API retryable error (e.g., 500)', async () => {
          server.use(
              http.post(env.LLM_ENDPOINT, () => {
                  return HttpResponse.json({ error: { message: 'Internal server error' } }, { status: 500 });
              })
          );
  
          const result = await callLLM(mockTask, env);
  
          expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Calling LLM for task: test-llm-event-id, type: detailed'));
          // Check the first argument of console.error
          expect(console.error).toHaveBeenCalledWith(expect.stringContaining('LLM API request failed with status 500: {"error":{"message":"Internal server error"}}'));
          expect(result).toEqual({
              success: false,
              error: expect.stringContaining('LLM API error 500: {"error":{"message":"Internal server error"}}'),
              rawResponse: expect.stringContaining('{"error":{"message":"Internal server error"}}'),
              isRetryable: true,
          });
      });
  
      it('should handle network error calling LLM API', async () => {
          server.use(
              http.post(env.LLM_ENDPOINT, () => {
                  return HttpResponse.error(); // Simulates a network error
              })
          );
  
          const result = await callLLM(mockTask, env);
  
          expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Calling LLM for task: test-llm-event-id, type: detailed'));
          // Check the first argument of console.error
          expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Network error calling LLM service:'), expect.anything(), expect.anything()); // Expecting message, error.message, error.stack
          expect(result).toEqual({
              success: false,
              error: expect.stringContaining('Network error calling LLM: Failed to fetch'),
              isRetryable: true,
          });
      });
  
      it('should handle LLM response where content is not valid JSON', async () => {
          server.use(
              http.post(env.LLM_ENDPOINT, () => {
                  return HttpResponse.json({
                      choices: [{ message: { content: 'This is not JSON' } }],
                  });
              })
          );
  
          const result = await callLLM(mockTask, env);
  
          expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Calling LLM for task: test-llm-event-id, type: detailed'));
          // Check the first argument of console.error
          expect(console.error).toHaveBeenCalledWith(expect.stringContaining('LLM content string was not valid JSON:'), expect.anything(), expect.anything()); // Expecting message, content string, error message
          expect(result).toEqual({
              success: false,
              error: expect.stringContaining('LLM content not valid JSON:'),
              rawResponse: expect.any(Object),
              isRetryable: false,
          });
      });
  
      it('should handle LLM response where content JSON is missing "success" field', async () => {
          server.use(
              http.post(env.LLM_ENDPOINT, () => {
                  return HttpResponse.json({
                      choices: [{ message: { content: JSON.stringify({ comments: [], summary: 'ok' }) } }],
                  });
              })
          );
  
          const result = await callLLM(mockTask, env);
  
          expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Calling LLM for task: test-llm-event-id, type: detailed'));
          // Check the first argument of console.error
          expect(console.error).toHaveBeenCalledWith(expect.stringContaining("LLM's output JSON string missing 'success' field:"), expect.anything()); // Expecting message and parsed content
          expect(result).toEqual({
              success: false,
              error: "LLM output format error: missing 'success'.",
              rawResponse: expect.any(Object),
              isRetryable: false,
          });
      });
  
      it('should handle LLM response structure unexpected (no content string)', async () => {
          server.use(
              http.post(env.LLM_ENDPOINT, () => {
                  return HttpResponse.json({
                      choices: [{ message: {} }], // Missing content
                  });
              })
          );
  
          const result = await callLLM(mockTask, env);
  
          expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Calling LLM for task: test-llm-event-id, type: detailed'));
          // Check the first argument of console.error
          expect(console.error).toHaveBeenCalledWith(expect.stringContaining('LLM response structure unexpected (no content string):'), expect.anything()); // Expecting message and jsonResponse
          expect(result).toEqual({
              success: false,
              error: "LLM response structure error.",
              rawResponse: expect.any(Object),
              isRetryable: false,
          });
      });
  
      it('should handle LLM API response not being valid JSON', async () => {
          server.use(
              http.post(env.LLM_ENDPOINT, () => {
                  return HttpResponse.text('This is not JSON response');
              })
          );
  
          const result = await callLLM(mockTask, env);
  
          expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Calling LLM for task: test-llm-event-id, type: detailed'));
          // Check the first argument of console.error
          expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to parse LLM API outer JSON response:'), expect.anything(), expect.anything()); // Expecting message, error message, responseText
          expect(result).toEqual({
              success: false,
              error: expect.stringContaining('LLM API response not JSON:'),
              rawResponse: expect.stringContaining('This is not JSON response'),
              isRetryable: true,
          });
      });
  
      it('should generate correct prompt for detailed review with files', async () => {
          const comments = [{ filePath: 'file1.txt', lineNumber: 5, comment: 'Comment 1' }];
          server.use(
              http.post(env.LLM_ENDPOINT, async ({ request }) => {
                  const body: any = await request.json(); // Cast to any
                  const prompt = body.messages[1].content;
                  expect(prompt).toContain('Please review the following code changes for the repository test-owner/test-repo.');
                  expect(prompt).toContain('Source: github');
                  expect(prompt).toContain('Pull Request: #1');
                  expect(prompt).toContain('File: file.txt');
                  expect(prompt).toContain('Diff:\ndiff content');
                  expect(prompt).toContain("Format your response as a JSON object with 'success' (boolean), 'comments' (array of objects with 'filePath', 'lineNumber' or 'position', and 'comment'), and 'summary' (string). Focus on detailed, line-by-line feedback.");
                  return HttpResponse.json({ choices: [{ message: { content: JSON.stringify({ success: true }) } }] });
              })
          );
          await callLLM(mockTask, env);
      });
  
      it('should generate correct prompt for general review with no files', async () => {
          mockTask.reviewType = 'general';
          mockTask.filesToReview = [];
          server.use(
              http.post(env.LLM_ENDPOINT, async ({ request }) => {
                  const body: any = await request.json(); // Cast to any
                  const prompt = body.messages[1].content;
                  expect(prompt).toContain('No specific file diffs provided. Please provide a general review.');
                  expect(prompt).toContain("Format your response as a JSON object with 'success' (boolean), 'comments' (array of objects with 'filePath', 'lineNumber' or 'position', and 'comment'), and 'summary' (string). Focus on a general overview and high-level suggestions.");
                  return HttpResponse.json({ choices: [{ message: { content: JSON.stringify({ success: true }) } }] });
              })
          );
          await callLLM(mockTask, env);
      });
  
      it('should use default model name if LLM_MODEL_NAME is not provided in env', async () => {
          env.LLM_MODEL_NAME = undefined;
          server.use(
              http.post(env.LLM_ENDPOINT, async ({ request }) => {
                  const body: any = await request.json(); // Cast to any
                  expect(body.model).toBe('gpt-3.5-turbo');
                  return HttpResponse.json({ choices: [{ message: { content: JSON.stringify({ success: true }) } }] });
              })
          );
          await callLLM(mockTask, env);
      });
  
      it('should use provided LLM_MODEL_NAME if available in env', async () => {
          env.LLM_MODEL_NAME = 'gpt-4o-mini';
          server.use(
              http.post(env.LLM_ENDPOINT, async ({ request }) => {
                  const body: any = await request.json(); // Cast to any
                  expect(body.model).toBe('gpt-4o-mini');
                  return HttpResponse.json({ choices: [{ message: { content: JSON.stringify({ success: true }) } }] });
              })
          );
          await callLLM(mockTask, env);
      });

      it('should handle extremely large diff content properly', async () => {
          const largeDiff = '+' + 'A'.repeat(10000) + '\n-' + 'B'.repeat(10000);
          mockTask.filesToReview = [{ path: 'large-file.txt', diff: largeDiff }];
          
          server.use(
              http.post(env.LLM_ENDPOINT, async ({ request }) => {
                  const body: any = await request.json();
                  const prompt = body.messages[1].content;
                  expect(prompt).toContain('large-file.txt');
                  expect(prompt).toContain(largeDiff.substring(0, 100)); // Check that large diff is included
                  return HttpResponse.json({
                      choices: [{ message: { content: JSON.stringify({
                          success: true,
                          comments: [{ filePath: 'large-file.txt', lineNumber: 1, comment: 'Comment on large file' }],
                          summary: 'Large file reviewed'
                      }) } }]
                  });
              })
          );
          
          const result = await callLLM(mockTask, env);
          
          expect(result.success).toBe(true);
          expect(result.comments?.[0].comment).toBe('Comment on large file');
          expect(console.error).not.toHaveBeenCalled();
      });

      it('should handle tasks with multiple files to review', async () => {
          mockTask.filesToReview = [
              { path: 'file1.js', diff: 'diff content 1' },
              { path: 'file2.js', diff: 'diff content 2' },
              { path: 'file3.js', diff: 'diff content 3' }
          ];
          
          server.use(
              http.post(env.LLM_ENDPOINT, async ({ request }) => {
                  const body: any = await request.json();
                  const prompt = body.messages[1].content;
                  expect(prompt).toContain('file1.js');
                  expect(prompt).toContain('file2.js');
                  expect(prompt).toContain('file3.js');
                  expect(prompt).toContain('diff content 1');
                  expect(prompt).toContain('diff content 2');
                  expect(prompt).toContain('diff content 3');
                  return HttpResponse.json({
                      choices: [{ message: { content: JSON.stringify({
                          success: true,
                          comments: [
                              { filePath: 'file1.js', lineNumber: 1, comment: 'Comment on file1' },
                              { filePath: 'file2.js', lineNumber: 1, comment: 'Comment on file2' },
                              { filePath: 'file3.js', lineNumber: 1, comment: 'Comment on file3' }
                          ],
                          summary: 'Multiple files reviewed'
                      }) } }]
                  });
              })
          );
          
          const result = await callLLM(mockTask, env);
          
          expect(result.success).toBe(true);
          expect(result.comments?.length).toBe(3);
          expect(result.comments?.[0].filePath).toBe('file1.js');
          expect(result.comments?.[1].filePath).toBe('file2.js');
          expect(result.comments?.[2].filePath).toBe('file3.js');
      });
  });
});