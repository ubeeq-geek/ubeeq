/** This coordinator does not impersonate an operator or own content state. Both
 * services use their original canonical store and saved-actor commit guards. */
export function createContentPreparationWorker<Workflow extends {recoverNext():Promise<unknown>}>(
    workflows:Workflow,
    releases:{readonly workflows:Workflow;runNextJob():Promise<unknown>}
) {
    if (typeof workflows?.recoverNext!=='function' || typeof releases?.runNextJob!=='function' || releases.workflows!==workflows)
        throw Error('Content preparation workers require the same workflow and release authority as HTTP.');
    let preparationTurn=true;
    return {
        async runNextJob(_workerId:string):Promise<unknown> {
            const first=preparationTurn;preparationTurn=!preparationTurn;
            const poll=first?[()=>workflows.recoverNext(),()=>releases.runNextJob()]:[()=>releases.runNextJob(),()=>workflows.recoverNext()];
            let failed=false,failure:unknown;
            for (const next of poll) {
                try { const result=await next();if(result!==undefined && result!==null)return result; }
                catch(error){failed=true;failure??=error;}
            }
            if(failed)throw failure;
        }
    };
}
