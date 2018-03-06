declare module 'twilio' {
	interface Message {
		from: string
		to: string
		body: string
	}
	interface Messages {
		create(message: Message): Promise<void>
	}
	interface TwilioInstance {
		messages: Messages
	}
	const twilio: (sid: string, authToken: string) => TwilioInstance
	export = twilio
}