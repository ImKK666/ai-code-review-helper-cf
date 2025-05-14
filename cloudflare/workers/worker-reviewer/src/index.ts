import type { Queue, KVNamespace, MessageBatch, ExecutionContext, Fetcher } from '@cloudflare/workers-types';

export interface Env {
	REVIEW_TASKS_QUEUE: Queue;
	REVIEW_RESULTS_KV: KVNamespace;
	LLM_API_KEY: string;
	GITHUB_TOKEN: string;
	GITLAB_TOKEN: string;
	LLM_ENDPOINT: string; 
	LLM_MODEL_NAME?: string;
}

interface WebhookQueueMessage {
	source: 'github' | 'gitlab';
	eventId: string;
	originalPayload: any; 
	reviewType?: 'detailed' | 'general'; 
	filesToReview?: Array<{ path: string; content?: string; diff?: string }>;
}

interface ReviewTask {
	repository: { fullName: string; id: number | string; defaultBranch: string; };
	pullRequest?: { id: number; number: number; headSha: string; diffUrl: string; commentsUrl: string; };
	mergeRequest?: { id: number; iid: number; projectId: number; headSha: string; diffUrl: string; notesUrl: string; };
	source: 'github' | 'gitlab';
	eventId: string; 
	reviewType: 'detailed' | 'general';
	filesToReview: Array<{ path: string; content?: string; diff?: string }>; 
}

export interface LLMComment { filePath: string; lineNumber?: number; position?: number; comment: string; }

interface LLMResponse {
	success: boolean;
	comments?: LLMComment[];
	summary?: string;
	error?: string;
	rawResponse?: any;
    isRetryable?: boolean; 
}

interface ReviewOutcome {
	taskId: string;
	status: 'completed' | 'failed' | 'error_calling_llm' | 'error_posting_comment';
	repository: string;
	pullRequest?: ReviewTask['pullRequest'];
	mergeRequest?: ReviewTask['mergeRequest'];
	reviewType: ReviewTask['reviewType'];
	comments?: LLMComment[];
	summary?: string;
	error?: string;
	llmRawResponse?: any;
	timestamp: string;
}

class RetryableWorkerError extends Error {
  public readonly isRetryable: boolean = true;
  constructor(message: string) {
    super(message);
    this.name = "RetryableWorkerError";
    Object.setPrototypeOf(this, RetryableWorkerError.prototype);
  }
}

export default {
	async queue(
		batch: MessageBatch<WebhookQueueMessage>,
		env: Env,
		ctx: ExecutionContext
	): Promise<void> {
		for (const message of batch.messages) {
			let reviewOutcome: ReviewOutcome | null = null;
			const incomingMessageBody = message.body;
			let currentTask: ReviewTask | null = null; 

			try {
				console.log(`Processing incoming message: ${message.id}`, JSON.stringify(incomingMessageBody).substring(0, 200));
				
				const op = incomingMessageBody.originalPayload;
				currentTask = {
					source: incomingMessageBody.source,
					eventId: incomingMessageBody.eventId,
					repository: {
						fullName: op.repository?.full_name || op.project?.path_with_namespace || 'unknown/repo',
						id: op.repository?.id || op.project?.id || 0,
						defaultBranch: op.repository?.default_branch || op.project?.default_branch || 'main',
					},
					pullRequest: op.pull_request ? {
						id: op.pull_request.id, number: op.pull_request.number,
						headSha: op.pull_request.head?.sha || op.pull_request.diff_head_sha,
						diffUrl: op.pull_request.diff_url, commentsUrl: op.pull_request.comments_url,
					} : undefined,
					mergeRequest: op.object_attributes && op.object_kind === 'merge_request' ? {
						id: op.object_attributes.id, iid: op.object_attributes.iid, projectId: op.project.id,
						headSha: op.object_attributes.last_commit?.id || op.object_attributes.diff_head_sha,
						diffUrl: `${op.project.web_url}/-/merge_requests/${op.object_attributes.iid}/diffs.json`,
						notesUrl: `https://gitlab.com/api/v4/projects/${op.project.id}/merge_requests/${op.object_attributes.iid}/notes`,
					} : undefined,
					reviewType: incomingMessageBody.reviewType || op.reviewType || 'general',
					filesToReview: incomingMessageBody.filesToReview || op.filesToReview || [],
				};

				if (!currentTask.filesToReview || currentTask.filesToReview.length === 0) {
					console.warn(`Task ${message.id} (Event: ${currentTask.eventId}) has no filesToReview.`);
				}

				const llmResponse = await callLLM(currentTask, env);
				reviewOutcome = processLLMResponse(llmResponse, currentTask);

				if (llmResponse.isRetryable && !llmResponse.success) {
                    throw new RetryableWorkerError(llmResponse.error || "Retryable LLM error from llmResponse");
                }

				if (reviewOutcome.status === 'completed' && reviewOutcome.comments && reviewOutcome.comments.length > 0) {
					await postCommentsToVCS(currentTask, reviewOutcome.comments, env);
				} else if (reviewOutcome.status !== 'completed') {
					console.error(`Review failed or no comments for task ${message.id} (Event: ${currentTask.eventId}): ${reviewOutcome.error}`);
				}
                
				const reviewId = `review:${currentTask.source}:${currentTask.repository.fullName}:${currentTask.pullRequest?.number || currentTask.mergeRequest?.iid}:${currentTask.eventId}`;
				await env.REVIEW_RESULTS_KV.put(reviewId, JSON.stringify(reviewOutcome), {
					metadata: { status: reviewOutcome.status, timestamp: reviewOutcome.timestamp },
				});
				console.log(`Review result stored for task ${message.id} with ID ${reviewId}`);
				
				message.ack();
				console.log(`Task ${message.id} (Event: ${currentTask.eventId}) processed and acknowledged.`);

			} catch (error: any) {
				console.error(`Critical error processing message ${message.id} (Event: ${incomingMessageBody.eventId}):`, error.message, error.stack);
				
                const isErrorRetryable = error instanceof RetryableWorkerError || (error && (error as any).isRetryable === true);

				if (!reviewOutcome && currentTask) { 
					reviewOutcome = {
						taskId: currentTask.eventId, status: 'failed', repository: currentTask.repository.fullName,
						pullRequest: currentTask.pullRequest, mergeRequest: currentTask.mergeRequest,
						reviewType: currentTask.reviewType, error: `Initial processing error: ${error.message}`,
						timestamp: new Date().toISOString(),
					};
				} else if (reviewOutcome) { 
                    if (!reviewOutcome.error?.includes(error.message)) {
					    reviewOutcome.error = reviewOutcome.error ? `${reviewOutcome.error}; Outer catch: ${error.message}` : `Outer catch: ${error.message}`;
                    }
                    if (isErrorRetryable && reviewOutcome.status !== 'failed') {
                        reviewOutcome.status = 'failed'; 
                    }
				} else { 
					reviewOutcome = {
						taskId: incomingMessageBody.eventId || 'unknown_event', status: 'failed',
						repository: incomingMessageBody.originalPayload?.repository?.full_name || incomingMessageBody.originalPayload?.project?.path_with_namespace || 'unknown/repo',
						pullRequest: incomingMessageBody.originalPayload?.pull_request ? { 
                                id: incomingMessageBody.originalPayload.pull_request.id, number: incomingMessageBody.originalPayload.pull_request.number,
                                headSha: incomingMessageBody.originalPayload.pull_request.head?.sha, diffUrl: incomingMessageBody.originalPayload.pull_request.diff_url,
                                commentsUrl: incomingMessageBody.originalPayload.pull_request.comments_url,
                            } : undefined,
                        mergeRequest: incomingMessageBody.originalPayload?.object_attributes && incomingMessageBody.originalPayload?.object_kind === 'merge_request' ? {
                                id: incomingMessageBody.originalPayload.object_attributes.id, iid: incomingMessageBody.originalPayload.object_attributes.iid,
                                projectId: incomingMessageBody.originalPayload.project.id, headSha: incomingMessageBody.originalPayload.object_attributes.last_commit?.id,
                                diffUrl: `${incomingMessageBody.originalPayload.project.web_url}/-/merge_requests/${incomingMessageBody.originalPayload.object_attributes.iid}/diffs.json`,
                                notesUrl: `https://gitlab.com/api/v4/projects/${incomingMessageBody.originalPayload.project.id}/merge_requests/${incomingMessageBody.originalPayload.object_attributes.iid}/notes`,
                            } : undefined,
						reviewType: incomingMessageBody.reviewType || 'general',
						error: `Critical processing error before task formation: ${error.message}`,
						timestamp: new Date().toISOString(),
					};
				}
                
				const errorReviewId = `review:${reviewOutcome.taskId}:${reviewOutcome.repository}:${currentTask?.pullRequest?.number || currentTask?.mergeRequest?.iid || incomingMessageBody.originalPayload?.pull_request?.number || incomingMessageBody.originalPayload?.object_attributes?.iid || 'unknown_pr_mr'}:${reviewOutcome.taskId}`;
				try {
					// Corrected: Added metadata to KV put in catch block
					await env.REVIEW_RESULTS_KV.put(errorReviewId, JSON.stringify(reviewOutcome), {
                        metadata: { status: reviewOutcome.status, timestamp: reviewOutcome.timestamp }
                    });
					console.log(`Failure outcome for message ${message.id} (Event: ${reviewOutcome.taskId}) stored in KV.`);
				} catch (kvError: any) {
					console.error(`Failed to store failure outcome for message ${message.id} (Event: ${reviewOutcome.taskId}) in KV:`, kvError.message);
				}

                if (isErrorRetryable) {
                    console.warn(`Task ${message.id} (Event: ${reviewOutcome.taskId}) will be retried due to retryable error: ${error.message}`);
                    throw error; 
                } else {
                    message.ack();
                    console.warn(`Task ${message.id} (Event: ${reviewOutcome.taskId}) acknowledged after non-retryable error. DLQ if configured. Error: ${error.message}`);
                }
			}
		}
	},
};

export async function callLLM(task: ReviewTask, env: Env): Promise<LLMResponse> {
	console.log(`Calling LLM for task: ${task.eventId}, type: ${task.reviewType}`);
	let promptContent = `Please review the following code changes for the repository ${task.repository.fullName}.\nSource: ${task.source}\n`;
	if (task.pullRequest) promptContent += `Pull Request: #${task.pullRequest.number}\n`;
	else if (task.mergeRequest) promptContent += `Merge Request: !${task.mergeRequest.iid}\n`;

	if (task.filesToReview && task.filesToReview.length > 0) {
		task.filesToReview.forEach((file: { path: string; diff?: string; content?: string }) => {
			promptContent += `\nFile: ${file.path}\n`;
			if (file.diff) promptContent += `Diff:\n${file.diff}\n`;
			else if (file.content) promptContent += `Content:\n${file.content}\n`;
		});
	} else {
		promptContent += "No specific file diffs provided. Please provide a general review.\n";
	}
	promptContent += "\nFormat your response as a JSON object with 'success' (boolean), 'comments' (array of objects with 'filePath', 'lineNumber' or 'position', and 'comment'), and 'summary' (string).";
    if (task.reviewType === 'detailed') promptContent += " Focus on detailed, line-by-line feedback.";
    else promptContent += " Focus on a general overview and high-level suggestions.";

	try {
		const llmRequestBody = {
			model: env.LLM_MODEL_NAME || "gpt-3.5-turbo", 
			messages: [{ role: "system", content: "You are an expert code reviewer." },{ role: "user", content: promptContent }],
			temperature: 0.5, response_format: { type: "json_object" },
		};
		console.log("Sending to LLM:", JSON.stringify(llmRequestBody).substring(0, 200) + "...");
		const response = await fetch(env.LLM_ENDPOINT, {
			method: "POST",
			headers: { "Authorization": `Bearer ${env.LLM_API_KEY}`, "Content-Type": "application/json",},
			body: JSON.stringify(llmRequestBody),
		});
		const responseText = await response.text(); 
		if (!response.ok) {
			const retryable = response.status >= 500;
			console.error(`LLM API request failed with status ${response.status}: ${responseText.substring(0,100)}`);
			return { success: false, error: `LLM API error ${response.status}: ${responseText.substring(0,100)}`, rawResponse: responseText, isRetryable: retryable };
		}
		try {
			const jsonResponse = JSON.parse(responseText);
			const llmContentString = jsonResponse.choices?.[0]?.message?.content;
			if (typeof llmContentString === 'string') {
				try {
					const parsedLlmContent = JSON.parse(llmContentString);
					if (typeof parsedLlmContent.success === 'boolean') {
						return { ...parsedLlmContent, rawResponse: jsonResponse, isRetryable: false };
					} else {
						console.error("LLM's output JSON string missing 'success' field:", parsedLlmContent);
						return { success: false, error: "LLM output format error: missing 'success'.", rawResponse: jsonResponse, isRetryable: false };
					}
				} catch (e: any) { 
					console.error("LLM content string was not valid JSON:", llmContentString.substring(0,100), e.message);
					return { success: false, error: "LLM content not valid JSON: " + e.message, rawResponse: jsonResponse, isRetryable: false };
				}
			}
			console.error("LLM response structure unexpected (no content string):", jsonResponse);
			return { success: false, error: "LLM response structure error.", rawResponse: jsonResponse, isRetryable: false };
		} catch (e: any) { 
			console.error("Failed to parse LLM API outer JSON response:", e.message, responseText.substring(0,100));
			return { success: false, error: "LLM API response not JSON: " + e.message, rawResponse: responseText, isRetryable: true };
		}
	} catch (error: any) { 
		console.error("Network error calling LLM service:", error.message, error.stack);
		return { success: false, error: `Network error calling LLM: ${error.message}`, isRetryable: true };
	}
}

function processLLMResponse(llmResponse: LLMResponse, task: ReviewTask): ReviewOutcome {
	const timestamp = new Date().toISOString();
	if (!llmResponse.success) {
		console.error(`LLM processing failed for task ${task.eventId}:`, llmResponse.error);
		const status = llmResponse.isRetryable === false ? 'error_calling_llm' : 'failed';
		return {
			taskId: task.eventId, status: status, repository: task.repository.fullName,
			pullRequest: task.pullRequest, mergeRequest: task.mergeRequest, reviewType: task.reviewType,
			error: llmResponse.error || "LLM processing failed.", llmRawResponse: llmResponse.rawResponse, timestamp,
		};
	}
	return {
		taskId: task.eventId, status: "completed", repository: task.repository.fullName,
		pullRequest: task.pullRequest, mergeRequest: task.mergeRequest, reviewType: task.reviewType,
		comments: llmResponse.comments, summary: llmResponse.summary, llmRawResponse: llmResponse.rawResponse, timestamp,
	};
}

export async function postCommentsToVCS(task: ReviewTask, comments: LLMComment[], env: Env): Promise<void> {
	if (!comments || comments.length === 0) {
		console.log(`No comments to post for task ${task.eventId}.`); return;
	}
	console.log(`Posting ${comments.length} comments for task ${task.eventId} to ${task.source}`);
	let vcsApiUrl: string, authToken: string, requestBodyBuilder: (comment: LLMComment) => any;

	if (task.source === 'github' && task.pullRequest) {
		vcsApiUrl = task.pullRequest.commentsUrl; 
		authToken = env.GITHUB_TOKEN;
		requestBodyBuilder = (c: LLMComment) => ({
			body: c.comment, commit_id: task.pullRequest!.headSha, path: c.filePath,
			line: c.lineNumber, position: c.position, 
		});
	} else if (task.source === 'gitlab' && task.mergeRequest) {
		vcsApiUrl = task.mergeRequest.notesUrl;
		authToken = env.GITLAB_TOKEN;
		requestBodyBuilder = (c: LLMComment) => {
			const body: any = { body: c.comment };
			if (c.filePath && (c.lineNumber || c.position) && task.mergeRequest) { 
				body.position = {
					position_type: "text", base_sha: task.mergeRequest.headSha, 
					start_sha: task.mergeRequest.headSha, head_sha: task.mergeRequest.headSha,
					new_line: c.lineNumber || c.position, old_path: c.filePath, new_path: c.filePath,
				};
			}
			return body;
		};
	} else {
		console.error(`Unsupported VCS or missing details for task ${task.eventId}: ${task.source}`);
		throw new Error(`Unsupported VCS: ${task.source}`);
	}

	for (const comment of comments) {
		try {
			const body = requestBodyBuilder(comment);
			console.log(`Posting to ${vcsApiUrl} for ${comment.filePath}: ${JSON.stringify(body).substring(0,100)}`);
			const response = await fetch(vcsApiUrl, {
				method: "POST",
				headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json", "User-Agent": "Cloudflare-Worker-Code-Reviewer", },
				body: JSON.stringify(body),
			});
			if (!response.ok) {
				const errorText = await response.text();
				console.error(`Failed to post comment to ${task.source} for ${task.eventId}, file ${comment.filePath}: ${response.status} ${errorText.substring(0,100)}`);
			} else {
				console.log(`Successfully posted comment to ${task.source} for ${task.eventId}, file ${comment.filePath}`);
			}
		} catch (error: any) {
			console.error(`Error during VCS post for ${task.eventId}, file ${comment.filePath}: ${error.message}`);
		}
		await new Promise(resolve => setTimeout(resolve, 200)); 
	}
}