import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';

export const GET: RequestHandler = async () => {
	try {
		const supabase = createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY);

		// Try a lightweight query — just fetch row count from books table
		const { error } = await supabase.from('books').select('id', { count: 'exact', head: true });

		if (error) {
			return json({
				connected: false,
				error: error.message,
				hint: error.hint ?? null
			}, { status: 500 });
		}

		return json({
			connected: true,
			url: PUBLIC_SUPABASE_URL,
			message: 'Supabase connection successful. books table is reachable.'
		});

	} catch (err: any) {
		return json({
			connected: false,
			error: err.message ?? 'Unknown error'
		}, { status: 500 });
	}
};
