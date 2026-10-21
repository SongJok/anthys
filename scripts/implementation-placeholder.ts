import ts from 'typescript';

function callable(node:ts.Node):node is ts.FunctionLikeDeclaration {
 return ts.isFunctionDeclaration(node)||ts.isFunctionExpression(node)||ts.isArrowFunction(node)||ts.isMethodDeclaration(node)||ts.isGetAccessorDeclaration(node)||ts.isSetAccessorDeclaration(node)||ts.isConstructorDeclaration(node);
}
/** A missing-value fallback after a real lookup is implemented behavior. An
 * explicit undefined-only function is still a placeholder, even after logging
 * or inside a nested declaration. This is a guard, not proof of completeness. */
export function hasImplementationPlaceholder(source:string,fileName='source.ts'):boolean {
 if(/\bTODO\b|throw new Error\(['"]Not implemented/.test(source))return true;
 const tree=ts.createSourceFile(fileName,source,ts.ScriptTarget.Latest,true,fileName.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
 let found=false;
 const visit=(node:ts.Node)=>{
  if(callable(node)&&node.body&&ts.isBlock(node.body)){
   let missing=false,value=false;
   const returns=(child:ts.Node)=>{
    if(callable(child))return;
    if(ts.isReturnStatement(child)&&child.expression){
     if(ts.isIdentifier(child.expression)&&child.expression.text==='undefined')missing=true;else value=true;
    }
    ts.forEachChild(child,returns);
   };
   returns(node.body);if(missing&&!value)found=true;
  }
  if(!found)ts.forEachChild(node,visit);
 };
 visit(tree);return found;
}
