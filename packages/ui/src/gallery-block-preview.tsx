import type {StoredPostBlock} from '@ubeeq/core';

export interface EditorWebsiteOptions {galleries?:readonly {id:string;title:string}[];creators?:readonly {id:string;title:string}[];pages:readonly {id:string;title:string}[];publications:readonly {id:string;title:string}[];}
/** A layout illustration only: never fetch gallery contents or images in the editor. */
export function GalleryBlockPreview({block,options}:{block:StoredPostBlock;options:EditorWebsiteOptions}) {
  const gallery=options.galleries?.find(row=>row.id===block.payload?.websiteGalleryId);
  const title=gallery?.title??(block.payload?.websiteGalleryId?'Unavailable gallery':'Selected publications / filters');
  return <div className="portable-gallery-preview" aria-label={`Gallery layout preview: ${title}`} title="Select to edit this gallery block">
    <p className="portable-gallery-preview-source"><span>Website gallery</span><strong>{title}</strong><small>Layout preview · placeholder galleries</small></p>
    <div className="portable-gallery-preview-grid">{[1,2].map(number=><div key={number} className="portable-gallery-preview-card">
      <div className={`portable-gallery-preview-cover portable-gallery-placeholder-${number}`}>
        <svg viewBox="0 0 160 200" fill="none" aria-hidden="true"><circle cx={number===1?115:45} cy="48" r="18" fill="currentColor" opacity=".25"/><path d={number===1?'M0 165 55 80 110 165 135 125 160 160V200H0Z':'M0 155 40 115 80 160 120 75 160 140V200H0Z'} fill="currentColor" opacity=".18"/></svg>
        <span className="portable-gallery-preview-count">Placeholder</span><span className="portable-gallery-preview-view"><span aria-hidden="true">▶</span> View gallery</span>
      </div><strong>Example gallery {number}</strong><small>Placeholder · no gallery content loaded</small>
    </div>)}</div>
  </div>;
}
