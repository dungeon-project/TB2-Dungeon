/** Every extension enters through the shared Dungeon startup policy. */
async function openDungeon() {
    const button=document.getElementById('open');
    if(button.disabled) return;
    button.disabled=true;
    const status=document.getElementById('status');
    try {
        const reply = await fetch(new URL('../../api/plugins/getPlugins',location.href),{signal:AbortSignal.timeout(10000)});
        if(!reply.ok) throw new Error('TeddyCloud plugin list is unavailable.');
        const folders=await reply.json();
        if(!Array.isArray(folders)) throw new Error('Invalid plugin list.');
        const bases=[];
        for(const folder of folders){
            if(typeof folder!=='string'||/[\\/]/.test(folder)||folder==='.'||folder==='..') continue;
            const base=new URL('../'+encodeURIComponent(folder)+'/',location.href);
            const metadata=await fetch(new URL('plugin.json',base),{signal:AbortSignal.timeout(10000)});
            if(!metadata.ok) continue;
            let value;try{value=await metadata.json();}catch{continue;}
            if(value.tb2Dungeon?.id==='core') bases.push(base);
        }
        if(bases.length!==1) throw new Error(bases.length ? 'Multiple Dungeon installations found.' : 'Install TB2 Dungeon first.');
        const target=new URL('index.html',bases[0]);
        target.searchParams.set('destination',"tile-custom-image");
        const dev=new URL(location.href).searchParams.get('dev');
        if(dev==='0'||dev==='1') target.searchParams.set('dev',dev);
        location.assign(target.href);
    } catch(error){status.textContent=error.message;button.disabled=false;}
}
document.getElementById('open').addEventListener('click',openDungeon);
void openDungeon();
