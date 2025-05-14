export interface Env {
	PROCESSED_EVENTS_KV: KVNamespace;
	REVIEW_TASKS_QUEUE: Queue;
	GITHUB_WEBHOOK_SECRET?: string; 
	GITLAB_WEBHOOK_SECRET?: string; 
}

const jsonResponse = (data: any, status: number = 200) => {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
};

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const { pathname } = url;

		if (request.method !== 'POST') {
            return jsonResponse({ error: 'Method Not Allowed' }, 405);
        }
        
        if (pathname.startsWith('/webhook/')) {
			const source = pathname.split('/')[2];

			if (!source || (source !== 'github' && source !== 'gitlab')) {
				return jsonResponse({ error: 'Invalid source. Must be "github" or "gitlab".' }, 400);
			}

			if (request.headers.get('content-type') !== 'application/json') {
				return jsonResponse({ error: 'Invalid content type. Must be application/json.' }, 400);
			}

			let payload: any;
			let rawBody: string;
			try {
				rawBody = await request.clone().text(); 
                payload = JSON.parse(rawBody);
			} catch (e) {
                const parseErrorMessage = e instanceof Error ? e.message : 'Unknown parsing error.';
                return jsonResponse({ error: 'Invalid JSON payload. ' + parseErrorMessage }, 400);
            }

			try {
				console.log(`Received webhook from ${source}. Validating signature...`);
				const isValidSignature = await verifySignature(request, env, source, rawBody);
				if (!isValidSignature) {
				 return jsonResponse({ error: 'Invalid signature.' }, 401);
				}
				console.log(`Signature for ${source} webhook is valid.`);

				const eventId = generateEventId(source, payload, request.headers); // Pass request.headers
				if (!eventId) {
					console.error(`Could not generate event ID for ${source} payload:`, payload);
					return jsonResponse({ error: 'Could not determine event ID for deduplication.' }, 400);
				}

				const existingEvent = await env.PROCESSED_EVENTS_KV.get(eventId);
				if (existingEvent) {
				 console.log(`Event ${eventId} already processed.`);
				 return jsonResponse({ message: 'Event already processed.', eventId }, 202);
				}
				
				await env.PROCESSED_EVENTS_KV.put(eventId, JSON.stringify({ timestamp: Date.now(), status: "received" }), { expirationTtl: 3600 });
				console.log(`Event ${eventId} recorded in PROCESSED_EVENTS_KV.`);
				
				const taskPayload = {
				 source,
				 eventId, 
				 originalPayload: payload,
				};
				await env.REVIEW_TASKS_QUEUE.send(taskPayload);
				console.log(`Task enqueued for event ${eventId} to REVIEW_TASKS_QUEUE.`);

				return jsonResponse({ message: `Webhook from ${source} (Event ID: ${eventId}) received, validated, and enqueued successfully.`, eventId }, 200);
			} catch (error) { 
				console.error('Error processing webhook:', error);
				const errorMessage = error instanceof Error ? error.message : 'Unknown error during webhook processing.';
				return jsonResponse({ error: `Error processing webhook: ${errorMessage}` }, 500);
			}
		}

		return jsonResponse({ error: 'Not found.' }, 404);
	},
};

async function verifySignature(request: Request, env: Env, source: string, rawBody: string): Promise<boolean> {
	if (source === 'github') {
		const signatureHeader = request.headers.get('X-Hub-Signature-256');
		if (!signatureHeader) {
			console.warn('GitHub webhook missing X-Hub-Signature-256 header.');
			return false;
		}
		if (!env.GITHUB_WEBHOOK_SECRET) {
			console.error('GITHUB_WEBHOOK_SECRET is not set. Cannot verify GitHub signature.');
			return false; 
		}
		const [algorithm, signatureHex] = signatureHeader.split('=');
		if (algorithm !== 'sha256') {
			console.warn(`Unsupported GitHub signature algorithm: ${algorithm}`);
			return false;
		}

		const encoder = new TextEncoder();
		const key = await crypto.subtle.importKey(
			'raw',
			encoder.encode(env.GITHUB_WEBHOOK_SECRET),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		);
		const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
		
        const hashArray = Array.from(new Uint8Array(mac));
        const computedSignatureHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

		return computedSignatureHex === signatureHex;

	} else if (source === 'gitlab') {
		const tokenHeader = request.headers.get('X-Gitlab-Token');
		if (!tokenHeader) {
			console.warn('GitLab webhook missing X-Gitlab-Token header.');
			return false;
		}
		if (!env.GITLAB_WEBHOOK_SECRET) {
			console.error('GITLAB_WEBHOOK_SECRET is not set. Cannot verify GitLab token.');
			return false; 
		}
		return tokenHeader === env.GITLAB_WEBHOOK_SECRET;
	}
	return false; 
}

function generateEventId(source: string, payload: any, headers: Headers): string | null { // Added headers parameter
	try {
		if (source === 'github') {
			if (payload.pull_request && payload.pull_request.node_id && payload.action) {
				return `gh_pr_${payload.pull_request.node_id}_${payload.action}_${payload.pull_request.head?.sha || payload.after || 'unknown_sha'}`;
			}
			if (payload.ref && payload.after && payload.repository && payload.repository.node_id) {
				return `gh_push_${payload.repository.node_id}_${payload.ref}_${payload.after}`;
			}
			if (payload.comment && payload.comment.node_id && payload.issue && payload.issue.node_id) {
				return `gh_comment_${payload.comment.node_id}_on_issue_${payload.issue.node_id}`;
			}
			const deliveryId = headers.get('X-GitHub-Delivery'); // Use headers parameter
			if (deliveryId) return `gh_delivery_${deliveryId}`;
			console.warn('Could not determine a stable event ID for GitHub payload:', JSON.stringify(payload).substring(0,200));
			return `gh_unknown_${crypto.randomUUID()}`; 

		} else if (source === 'gitlab') {
			const deliveryId = headers.get('X-Gitlab-Event-UUID'); // Use headers parameter
            if (deliveryId) return `gl_delivery_${deliveryId}`;

			if (payload.object_kind === 'merge_request' && payload.project && payload.project.id && payload.object_attributes && payload.object_attributes.iid && payload.object_attributes.last_commit && payload.object_attributes.last_commit.id) {
				return `gl_mr_${payload.project.id}_${payload.object_attributes.iid}_${payload.object_attributes.last_commit.id}`;
			}
			if (payload.object_kind === 'push' && payload.project_id && payload.ref && payload.after) {
				return `gl_push_${payload.project_id}_${payload.ref}_${payload.after}`;
			}
			if (payload.object_kind === 'note' && payload.project && payload.project.id && payload.object_attributes && payload.object_attributes.id) {
				return `gl_note_${payload.project.id}_${payload.object_attributes.id}`;
			}
			console.warn('Could not determine a stable event ID for GitLab payload:', JSON.stringify(payload).substring(0,200));
			return `gl_unknown_${crypto.randomUUID()}`; 
		}
	} catch (e) {
		console.error("Error generating event ID:", e, "Payload:", JSON.stringify(payload).substring(0,200));
		return `error_event_id_${crypto.randomUUID()}`;
	}
	return null; 
}