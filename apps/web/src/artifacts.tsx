import React from 'react';
import { ArtifactsFlow, createArtifactsTransport, artifactFormats, validArtifactTarget, type ArtifactFormat, type ArtifactMetadata, type ArtifactOutcome } from './artifacts-flow.js';
import './artifacts.css';
export interface ArtifactsProps {
    csrf: string;
    taskId: string;
    runId: string;
    onSessionLost?: () => void;
}
const labels: Record<ArtifactFormat, string> = { md: 'Markdown 文本', txt: '纯文本', csv: 'CSV 表格', json: 'JSON 数据', html: 'HTML 文档', xlsx: 'Excel 表格', docx: 'Word 文档', pdf: 'PDF 文档' };
const classifications: Record<ArtifactMetadata['source']['classification'], string> = { PUBLIC: '公开资料', INTERNAL: '内部资料', CONFIDENTIAL: '保密资料', RESTRICTED: '严格受限资料' };
const verification: Record<ArtifactMetadata['source']['verification'], string> = { VERIFIED: '来源已核验', PARTIAL: '仅支持部分结果', UNVERIFIED: '来源尚未核验' };
const dateLabel = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZoneName: 'short' });
const sizeLabel = (size: number) => size < 1024 ? `${size} 字节` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
/** Mount in the task workbench. Changing the session or target remounts and erases all old metadata. */
export function Artifacts(props: ArtifactsProps) {
    if (!props.csrf || !validArtifactTarget(props.taskId, props.runId))
        return <section className="artifacts-panel" aria-label="任务成果"><h3>任务成果</h3><p role="status">请登录并选择有效的本次运行，再读取成果。</p></section>;
    return <ArtifactsSession key={JSON.stringify([props.csrf, props.taskId, props.runId])} {...props}/>;
}
function ArtifactsSession({ csrf, taskId, runId, onSessionLost }: ArtifactsProps) {
    const [flow] = React.useState(() => new ArtifactsFlow(createArtifactsTransport(csrf), { taskId, runId }));
    const [, rerender] = React.useReducer((value: number) => value + 1, 0), [format, setFormat] = React.useState<ArtifactFormat>('pdf'), [notice, setNotice] = React.useState(''), mounted = React.useRef(true), sessionLost = React.useRef(onSessionLost), selectId = React.useId();
    sessionLost.current = onSessionLost;
    const report = (outcome: ArtifactOutcome | null) => { if (!mounted.current || !outcome)
        return; setNotice(outcome.notice); if (outcome.sessionLost)
        sessionLost.current?.(); };
    const read = async () => { const pending = flow.read(); rerender(); report(await pending); if (mounted.current)
        rerender(); };
    const create = async (event: React.FormEvent) => { event.preventDefault(); const pending = flow.create(format); rerender(); report(await pending); if (mounted.current)
        rerender(); };
    const download = async (id: string) => {
        const pending = flow.download(id);
        rerender();
        const result = await pending;
        if (!mounted.current || !result || document.visibilityState !== 'visible')
            return;
        report(result.outcome);
        if (result.file) {
            try {
                const bytes = Uint8Array.from(result.file.bytes), url = URL.createObjectURL(new Blob([bytes], { type: result.file.mime })), link = document.createElement('a');
                link.href = url;
                link.download = result.file.fileName;
                link.rel = 'noopener';
                document.body.append(link);
                link.click();
                link.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                setNotice('文件已核验并交给浏览器保存；保存状态请查看浏览器下载记录。');
            }
            catch {
                flow.clear();
                setNotice('浏览器未能接收文件，旧入口已清除，请重新读取后再下载。');
            }
        }
        rerender();
    };
    React.useEffect(() => {
        mounted.current = true;
        if (document.visibilityState === 'visible')
            void read();
        const hide = () => { if (document.visibilityState === 'hidden') {
            const outcome = flow.cancel();
            setNotice(outcome.notice);
            rerender();
        } };
        document.addEventListener('visibilitychange', hide);
        return () => { mounted.current = false; flow.clear(); document.removeEventListener('visibilitychange', hide); };
    }, [flow]);
    const expiresAt = flow.expiresAt;
    React.useEffect(() => { if (expiresAt === null)
        return; const remaining = Math.max(0, expiresAt - Date.now()); const timeout = setTimeout(() => { if (mounted.current && flow.expire()) {
        setNotice('这份列表已过期，下载入口已隐藏，请重新读取。');
        rerender();
    } }, remaining + 1); return () => clearTimeout(timeout); }, [flow, expiresAt]);
    const items = flow.items;
    return <section className="artifacts-panel" aria-label="任务成果" aria-busy={flow.busy}>
  <div className="artifacts-heading"><div><p className="artifacts-eyebrow">本次运行</p><h3>任务成果</h3></div><button type="button" className="quiet" disabled={flow.busy} onClick={() => void read()}>重新读取</button></div>
  <p className="artifacts-protection">成果不公开分享。每次下载都会重新核验登录与来源权限，临时下载授权在30秒内仅能使用一次；文件信息不代表下载授权。</p>
  <form className="artifacts-create" onSubmit={event => void create(event)} aria-label="生成本次运行成果">
   <div><label htmlFor={selectId}>成果格式</label><select id={selectId} value={format} disabled={flow.busy} onChange={event => setFormat(event.target.value as ArtifactFormat)}>{artifactFormats.map(value => <option key={value} value={value}>{labels[value]}</option>)}</select></div>
   <button type="submit" disabled={!flow.canCreate}>生成受保护成果</button>
  </form>
  <p className="artifacts-help">仅导出这次运行由服务端核对的结果。格式检查通过不代表资料完整；来源不足、不适合该格式或当前结果不支持导出时，服务端会明确拒绝生成。</p>
  <p className="artifacts-help">列表也可能包含本次任务的工具草稿。草稿中的事实尚未核验，不会因文件生成或下载而成为已核实资料。</p>
  {flow.resultUnknown && <p className="artifacts-warning">上次生成结果仍待核对，已停止重复生成。请重新读取文件列表；若仍不确定，请联系管理员核对。</p>}
  {notice && <p className="artifacts-notice" role="status" aria-live="polite">{notice}</p>}
  {flow.busy && <button type="button" className="quiet" onClick={() => { report(flow.cancel()); rerender(); }}>停止等待并清除入口</button>}
  {!flow.busy && flow.fresh && items.length === 0 && <p className="artifacts-empty">这次运行还没有可展示的成果。</p>}
  {items.length > 0 && <ul className="artifacts-list">{items.map(item => <li key={item.id}><article className="artifact-card">
   <div className="artifact-card-heading"><h4>{item.fileName}</h4><span className="artifact-format">{item.format.toUpperCase()}</span></div>
   <p className="artifact-facts">{sizeLabel(item.byteSize)} · {classifications[item.source.classification]} · {dateLabel(item.createdAt)}</p>
   <div className={'artifact-source artifact-source-' + item.source.verification.toLowerCase()}><strong>{item.source.mode === 'TOOL_DRAFT' ? '工具草稿 · 事实未核验' : verification[item.source.verification]}</strong>{item.source.mode === 'TOOL_DRAFT' && <p>这是工具生成的私有草稿。格式检查不证明事实、来源或外部动作已完成，请核对原始资料后再使用。</p>}<p>{item.source.notice}</p><p className="artifact-source-time">{item.source.mode === 'TOOL_DRAFT' ? '草稿检查时间' : '资料核对时间'}：{dateLabel(item.source.asOf)}</p>{item.source.verification === 'PARTIAL' && <p>请保留部分结果限定，不能据此推断全部情况。</p>}{item.source.verification === 'UNVERIFIED' && <p>文件可打开不代表来源结论已核实，请先核对资料。</p>}</div>
   <div className="artifact-card-footer"><button type="button" className="artifact-download" disabled={flow.busy} onClick={() => void download(item.id)}>受保护下载</button><details><summary>文件核验摘要</summary><p>{item.source.mode === 'TOOL_DRAFT' ? '摘要仅用于核对文件字节；格式检查不证明草稿中的事实，也不授予访问权限。' : '格式与内容通过生成检查。摘要仅用于核对文件，不授予访问权限。'}</p><code>SHA-256 {item.sha256}</code></details></div>
  </article></li>)}</ul>}
 </section>;
}
