// No standalone network mode. Only the owned parent's private IPC START arms it.
if(!process.send){process.stderr.write('DM_CAPTURE_CHILD_CHANNEL_REQUIRED\n');process.exit(64);}
const {runDmMetadataChild}=await import('../packages/dingtalk/src/dm-metadata-child.js');
runDmMetadataChild();
