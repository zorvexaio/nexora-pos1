"""Generate the packaging icons from one vector-like Pillow drawing."""
from pathlib import Path
import struct
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / 'build'
BUILD.mkdir(exist_ok=True)

def icon(size):
    im = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    pad = size * .06
    d.rounded_rectangle((pad, pad, size-pad, size-pad), radius=size*.20, fill='#155eef')
    d.rounded_rectangle((size*.19, size*.18, size*.81, size*.82), radius=size*.07, fill='#ffffff')
    d.rounded_rectangle((size*.27, size*.27, size*.73, size*.48), radius=size*.025, fill='#dbeafe')
    for y in (.58, .69):
        for x in (.32, .50, .68):
            d.ellipse((size*(x-.045), size*(y-.045), size*(x+.045), size*(y+.045)), fill='#155eef')
    d.rounded_rectangle((size*.31, size*.77, size*.69, size*.80), radius=size*.01, fill='#93c5fd')
    return im

master = icon(1024)
master.save(BUILD / 'icon.png')
master.save(BUILD / 'icon.ico', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
# ICNS is a small container of PNG representations. Finder selects the closest size.
chunks = []
for typ, size in [('icp4',16),('icp5',32),('icp6',64),('ic07',128),('ic08',256),('ic09',512),('ic10',1024)]:
    from io import BytesIO
    raw = BytesIO(); master.resize((size,size), Image.Resampling.LANCZOS).save(raw, format='PNG')
    data = raw.getvalue(); chunks.append(typ.encode('ascii') + struct.pack('>I', len(data)+8) + data)
body = b''.join(chunks)
(BUILD / 'icon.icns').write_bytes(b'icns' + struct.pack('>I', len(body)+8) + body)
print('Generated', BUILD / 'icon.png', BUILD / 'icon.ico', BUILD / 'icon.icns')
