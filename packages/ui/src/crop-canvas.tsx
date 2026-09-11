import { useEffect, useRef, type PointerEvent } from 'react';
import { cropPreviewPoint, type CropPreviewRect } from './crop-preview.js';

/** Presentation only. Applications provide keyboard controls, labels and images. */
export function CropCanvas({ image, crop, width, height, className, onPoint, label = 'Crop preview' }: {
  image?: HTMLImageElement; crop?: CropPreviewRect; width: number; height: number;
  className?: string; label?: string; onPoint?: (x: number, y: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, width, height);
    if (image && crop) context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
  }, [crop, height, image, width]);
  const selectPoint = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!onPoint || event.button !== 0) return;
    const point = cropPreviewPoint(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY);
    if (point) onPoint(point.x, point.y);
  };
  return <canvas ref={ref} width={width} height={height} className={className} onPointerDown={selectPoint} aria-label={label} />;
}
