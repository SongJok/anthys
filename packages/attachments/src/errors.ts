export class AttachmentFailure extends Error {constructor(readonly code:string,readonly retryable=false){super(code);this.name='AttachmentFailure';}}
