export interface StepLog {
	id: string;
	step: 'research' | 'outline' | 'drafting' | 'review' | 'illustrate' | 'complete';
	status: 'pending' | 'running' | 'success' | 'error';
	message: string;
	timestamp: string;
}

export interface CoverSettings {
	title: string;
	subtitle: string;
	author: string;
	titleColor: string;
	subtitleColor: string;
	authorColor: string;
	titleSize: number; // in px
	subtitleSize: number; // in px
	authorSize: number; // in px
	titleFont: 'Lora' | 'Inter' | 'Georgia' | 'Arial';
	alignment: 'left' | 'center' | 'right';
	textPosition: 'top' | 'middle' | 'bottom';
	bgImagePrompt: string;
	bgImageUrl: string | null;
	useUltraRealistic: boolean;
	overlayOpacity: number; // 0 to 1
}

export interface Chapter {
	id: string;
	title: string;
	order: number;
	summary: string;
	content: string;
	researchNotes: string;
	illustrationUrl: string | null;
	status: 'pending' | 'writing' | 'verifying' | 'completed' | 'failed';
}

export interface Book {
	id: string;
	title: string;
	subtitle: string;
	author: string;
	genre: string;
	length: 'short' | 'medium' | 'long';
	tone: string;
	structure: string;
	useUltraRealistic: boolean;
	researchDepth: 'basic' | 'deep';
	selfCorrectionLevel: 'standard' | 'rigorous';
	
	coverSettings: CoverSettings;
	chapters: Chapter[];
	
	status: 'idle' | 'researching' | 'outlining' | 'writing' | 'verifying' | 'illustrating' | 'completed' | 'failed';
	currentStep: string;
	logs: StepLog[];
	
	createdAt: string;
	updatedAt: string;
}

export interface ApiKeys {
	anthropicKey: string;
	exaKey: string;
	imageKey: string;
	imageProvider: 'kie' | '69labs';
	useMockMode: boolean;
}
