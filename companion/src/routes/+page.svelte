<script lang="ts">
  import { untrack } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import type { PageData } from './$types';
  let { data }: { data: PageData } = $props();
  let selected = $state<string | null>(null);
  let busy = $state(false);
  let message = $state('');
  let failed = $state(false);
  let seconds = $state<number | undefined>(untrack(() => data.settings.seconds));
  let crossfadeSeconds = $state<number | undefined>(untrack(() => data.settings.crossfadeSeconds));
  let fit = $state(untrack(() => data.settings.fit));
  let ordering = $state(untrack(() => data.settings.ordering));
  const current = $derived(data.photos.find(p => p.id === selected) ?? data.photos[0]);

  async function checked(response: Response) {
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || `Request failed (${response.status})`);
    }
  }
  async function upload(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    busy = true; failed = false;
    let added = 0;
    try {
      for (const file of files) {
        message = `Preparing ${file.name}…`;
        await checked(await fetch(`/api/photos?name=${encodeURIComponent(file.name)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file
        }));
        added++;
      }
      message = `${added} photo${added === 1 ? '' : 's'} added.`;
    } catch (e) { failed = true; message = `${added} added. ${(e as Error).message}`; }
    finally { input.value = ''; await invalidateAll(); busy = false; }
  }
  async function save(event: SubmitEvent) {
    event.preventDefault(); busy = true; failed = false;
    try {
      await checked(await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seconds, crossfadeSeconds, fit, ordering }) }));
      await invalidateAll(); message = 'Settings saved. The frame will use them on its next request.';
    } catch (e) { failed = true; message = (e as Error).message; }
    finally { busy = false; }
  }
  async function remove(id: string) {
    busy = true; failed = false;
    try {
      await checked(await fetch(`/api/photos/${id}`, { method: 'DELETE' }));
      await invalidateAll(); message = 'Photo removed.';
    } catch (e) { failed = true; message = (e as Error).message; }
    finally { busy = false; }
  }
</script>

<svelte:head><title>Still — Photo frame</title><meta name="description" content="Your photos, at home. Manage your picture frame."/></svelte:head>

<div class="shell">
  <header><a href="/" class="brand"><span class="brand-icon">▣</span> still<span class="brand-dot">.</span></a><span class="header-note">YOUR PHOTOS, AT HOME</span><span class="local"><i></i> Local library</span></header>
  <main>
    <div class="intro"><div><p class="eyebrow">A LITTLE SPACE FOR GOOD MEMORIES</p><h1>Make yourself at home.</h1><p class="sub">Add the photos you love. Let your frame do the rest.</p></div><label class="upload" class:disabled={busy}>＋ Add photos<input aria-label="Add photos" type="file" accept="image/jpeg,image/png,image/webp,image/tiff,image/heic,image/heif,.heic,.heif" multiple onchange={upload} disabled={busy}/></label></div>
    <div class="notice" class:error={failed} role="status" aria-live="polite">{message || 'Photos stay on this computer. No cloud account needed.'}</div>
    <section class="workspace" aria-label="Frame preview and settings">
      <div class="preview-panel"><div class="section-label"><h2>On your frame</h2><span>PREVIEW · 1024 × 600</span></div>
        <div class="frame"><div class="screen">{#if current}<img src={`/photo/${current.id}?fit=${fit}`} alt={current.name}/>{:else}<div class="empty-preview"><span>▧</span><h3>A home for your moments.</h3><p>Add your first photo to see it here.</p></div>{/if}</div></div>
        <div class="preview-caption"><span>{current?.name ?? 'Your next favorite view'}</span><span>{fit === 'contain' ? 'Whole photo' : 'Fill screen'}</span></div>
      </div>
      <aside><p class="eyebrow">SET THE PACE</p><h2>A slideshow that suits you.</h2><form onsubmit={save}>
        <label for="seconds">Time per photo</label><div class="seconds"><input id="seconds" type="number" min="1" step="1" required placeholder="Enter seconds" bind:value={seconds}/><span>seconds</span></div>
        <label for="crossfadeSeconds">Crossfade time</label><div class="seconds"><input id="crossfadeSeconds" type="number" min="0" step="1" required placeholder="Enter seconds" bind:value={crossfadeSeconds}/><span>seconds</span></div>
        <label for="fit">Photo fit</label><select id="fit" bind:value={fit}><option value="contain">Whole photo · black borders</option><option value="cover">Fill screen · crop edges</option></select>
        <label for="ordering">Play order</label><select id="ordering" bind:value={ordering}><option value="sequential">In upload order</option><option value="random">Random · no immediate repeat</option></select>
        <button class="save" disabled={busy}>Save settings <span>↗</span></button>
      </form><p class="hint">{#if data.settings.seconds === null}Set the time to start automatic changes. Until then, touch the frame to change the photo.{:else}Touch the left or right side of the frame to change the photo. Touch the center to pause or resume.{/if}</p></aside>
    </section>
    <section class="library"><div class="library-heading"><h2>Your collection <span>{data.photos.length}</span></h2><p>Small moments. Always in view.</p></div>
      {#if data.photos.length}<div class="grid">{#each data.photos as photo}<article class:active={current?.id === photo.id}><button class="photo" onclick={() => selected = photo.id} aria-label={`Preview ${photo.name}`}><img loading="lazy" src={`/photo/${photo.id}?fit=cover`} alt={photo.name}/></button><div class="photo-meta"><span title={photo.name}>{photo.name}</span><button class="remove" aria-label={`Remove ${photo.name}`} disabled={busy} onclick={() => remove(photo.id)}>Remove</button></div></article>{/each}</div>
      {:else}<div class="empty-library"><span>＋</span><div><h3>Start with a favorite.</h3><p>Use “Add photos” to upload JPEG, PNG, WebP, TIFF, or HEIC/HEIF files.</p></div></div>{/if}
    </section>
  </main><footer><span>still. <span class="muted">Made for the moments between.</span></span><span>WAVESHARE 7″ TYPE B</span></footer>
</div>

<style>
  :global(*){box-sizing:border-box} :global(body){margin:0;background:#f7f6f2;color:#26352e;font-family:Inter,ui-sans-serif,system-ui,sans-serif;font-size:14px} :global(button),:global(input),:global(select){font:inherit} :global(button),:global(select){cursor:pointer} :global(button:focus-visible),:global(a:focus-visible),:global(input:focus-visible),:global(select:focus-visible){outline:3px solid #ad683e;outline-offset:4px} .shell{max-width:1440px;margin:auto;padding:0 5%} header{height:100px;border-bottom:1px solid #dedfd7;display:flex;align-items:center;justify-content:space-between;gap:20px}.brand{text-decoration:none;color:inherit;font-size:36px;font-weight:650;letter-spacing:-2px}.brand-icon{font-size:32px;margin-right:10px;font-weight:400}.brand-dot{color:#ae6b43}.header-note{font-size:10px;letter-spacing:2px;color:#7a827b}.local{display:flex;align-items:center;gap:8px;font-size:12px}.local i{height:6px;width:6px;border-radius:50%;background:#627e5a}.intro{display:flex;justify-content:space-between;align-items:center;margin-top:45px;gap:20px}.eyebrow{font-size:10px;font-weight:600;letter-spacing:1.8px;color:#7d8578;margin:0 0 13px}h1{font-family:Georgia,serif;font-weight:400;letter-spacing:-1.6px;font-size:44px;margin:0 0 13px}.sub{color:#798077;margin:0}.upload{position:relative;overflow:hidden;background:#304c3a;color:white;padding:15px 24px;border-radius:6px;font-weight:600;white-space:nowrap;cursor:pointer}.upload input{position:absolute;inset:0;opacity:0;width:100%;cursor:pointer}.upload:focus-within{outline:3px solid #ad683e;outline-offset:4px}.disabled{opacity:.6}.notice{min-height:52px;padding:18px 0;color:#7a8277;font-size:12px}.notice.error{color:#a13722}.workspace{display:grid;grid-template-columns:minmax(0,1fr) 295px;border:1px solid #dedfd7;border-radius:12px;overflow:hidden;background:#efeee7}.preview-panel{padding:28px 38px}.section-label{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;gap:10px}h2{font-size:15px;font-weight:600;margin:0}.section-label span{color:#7f867c;font-size:9px;letter-spacing:1.2px}.frame{padding:14px;background:#cab79c;border:1px solid #b7a487;border-radius:4px;box-shadow:0 12px 25px #383d3320,inset 0 0 0 3px #deceb6}.screen{aspect-ratio:1024/600;background:#18241e;overflow:hidden;display:grid;place-items:center}.screen img{width:100%;height:100%;object-fit:contain}.empty-preview{text-align:center;color:#cbd0bb;padding:20px}.empty-preview>span{font-size:40px;color:#a6b694}.empty-preview h3{font-family:Georgia,serif;font-size:26px;font-weight:400;margin:14px 0 10px}.empty-preview p{font-size:12px;color:#8e9e8a}.preview-caption{display:flex;justify-content:space-between;gap:20px;margin-top:19px;color:#757c71;font-size:11px}.preview-caption span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}aside{padding:32px 26px;background:#fafaf6;border-left:1px solid #dedfd7}aside h2{font-family:Georgia,serif;font-size:24px;line-height:1.25;font-weight:400;margin-bottom:24px}form label{display:block;margin:18px 0 8px;font-size:11px;font-weight:600}input,select{width:100%;border:1px solid #dcdfd5;border-radius:5px;padding:11px;background:#fff;color:#344238}select{font-size:12px}.seconds{position:relative}.seconds input{padding-right:74px}.seconds span{position:absolute;right:13px;top:12px;color:#82897e;font-size:12px}.save{width:100%;border:0;border-radius:5px;background:#304c3a;color:#fff;padding:13px;margin-top:23px;display:flex;justify-content:space-between}.save:disabled,button:disabled{opacity:.5;cursor:wait}.hint{color:#8a9085;font-size:11px;line-height:1.7;margin-bottom:0}.library{margin-top:40px}.library-heading{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:22px}.library-heading h2{font-size:20px;font-family:Georgia,serif;font-weight:400}.library-heading h2 span{font:11px system-ui;background:#e7eade;padding:4px 8px;border-radius:12px;margin-left:8px}.library-heading p{font-size:11px;color:#92988d}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px}article{min-width:0}.photo{display:block;width:100%;border:0;padding:0;background:#e6e7df;border-radius:7px;overflow:hidden;aspect-ratio:1024/600}.photo img{width:100%;height:100%;object-fit:cover;display:block}.active .photo{outline:2px solid #6f8862;outline-offset:4px}.photo-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:12px;font-size:11px}.photo-meta>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.remove{background:none;border:0;font-size:10px;color:#866455;padding:4px}.empty-library{border:1px dashed #d2d6ca;border-radius:8px;display:flex;align-items:center;justify-content:center;gap:18px;padding:32px}.empty-library>span{font-size:24px;color:#6f8068}.empty-library h3{font-size:14px;font-weight:500;margin:0 0 6px}.empty-library p{margin:0;font-size:12px;color:#7f887a}footer{display:flex;justify-content:space-between;gap:20px;border-top:1px solid #dedfd7;margin-top:45px;padding:23px 0 28px;font-size:11px;color:#737f70}footer>span:last-child{font-size:9px;letter-spacing:1.2px}.muted{color:#91998b;margin-left:14px}@media(min-width:1440px){.shell{padding:0 70px}}@media(max-width:900px){.workspace{grid-template-columns:minmax(0,1fr) 260px}.preview-panel{padding:24px}.grid{grid-template-columns:repeat(3,minmax(0,1fr))}h1{font-size:36px}}@media(max-width:700px){header{height:76px}.header-note{display:none}.intro{margin-top:30px;align-items:flex-start;flex-direction:column}h1{font-size:34px}.workspace{grid-template-columns:1fr}aside{border-left:0;border-top:1px solid #dedfd7}.preview-panel{padding:20px}.section-label span{font-size:8px}.grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.library-heading p{display:none}.empty-preview h3{font-size:20px}.empty-library{padding:24px}.empty-library p{line-height:1.6}footer .muted{display:none}}
</style>
