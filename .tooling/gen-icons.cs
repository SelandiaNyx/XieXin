// 生成墨阁的应用图标（PNG + ICO），只依赖 .NET 的 System.Drawing，无需额外工具。
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;

class IconGen
{
    static Bitmap Render(int size, string fontFile, string glyph)
    {
        var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.Clear(Color.Transparent);

            var rect = new Rectangle(0, 0, size, size);
            int radius = (int)(size * 0.22);
            // 写心：青墨到紫罗兰的渐变，比原来的深紫更清爽现代
            using (var path = RoundedRect(rect, radius))
            using (var brush = new LinearGradientBrush(rect,
                       Color.FromArgb(255, 92, 122, 240),
                       Color.FromArgb(255, 126, 74, 200), 45f))
            {
                g.FillPath(brush, path);
            }
            // 顶部高光，增加体积感
            using (var gloss = new LinearGradientBrush(rect,
                       Color.FromArgb(70, 255, 255, 255), Color.FromArgb(0, 255, 255, 255), 90f))
            {
                using (var path = RoundedRect(rect, radius))
                {
                    g.FillPath(gloss, path);
                }
            }

            // 纸页
            float pad = size * 0.17f;
            var page = new RectangleF(pad, pad * 0.78f, size - pad * 2f, size - pad * 1.65f);
            using (var shadow = new SolidBrush(Color.FromArgb(70, 20, 16, 60)))
            {
                g.FillRectangle(shadow, page.X + size * 0.018f, page.Y + size * 0.024f, page.Width, page.Height);
            }
            using (var paper = new SolidBrush(Color.FromArgb(250, 249, 246)))
            {
                g.FillRectangle(paper, page);
            }
            // 稿纸横线
            using (var pen = new Pen(Color.FromArgb(70, 80, 90, 150), Math.Max(1f, size * 0.011f)))
            {
                for (int i = 0; i < 3; i++)
                {
                    float y = page.Y + page.Height * (0.72f + i * 0.11f);
                    float w = page.Width * (i == 2 ? 0.42f : 0.62f);
                    g.DrawLine(pen, page.X + page.Width * 0.16f, y, page.X + page.Width * 0.16f + w, y);
                }
            }

            // 主字（居中偏上）
            string family = null;
            var pfc = new PrivateFontCollection();
            if (fontFile != null && File.Exists(fontFile))
            {
                try { pfc.AddFontFile(fontFile); } catch { }
            }
            foreach (var f in pfc.Families) { family = f.Name; break; }
            if (family == null) family = "Microsoft YaHei";
            float fontSize = size * 0.40f;
            var textRect = new RectangleF(0, page.Y + page.Height * 0.02f, size, page.Height * 0.62f);
            var ink = Color.FromArgb(255, 44, 40, 96);
            var fmt = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
            try
            {
                using (var ff = new FontFamily(family))
                using (var font = new Font(ff, fontSize, FontStyle.Bold, GraphicsUnit.Pixel))
                using (var brush = new SolidBrush(ink))
                {
                    g.DrawString(glyph, font, brush, textRect, fmt);
                }
            }
            catch
            {
                using (var font = new Font(family, fontSize, FontStyle.Bold, GraphicsUnit.Pixel))
                using (var brush = new SolidBrush(ink))
                {
                    g.DrawString(glyph, font, brush, textRect, fmt);
                }
            }
            fmt.Dispose();
        }
        return bmp;
    }

    static GraphicsPath RoundedRect(Rectangle r, int radius)
    {
        var path = new GraphicsPath();
        int d = radius * 2;
        path.AddArc(r.X, r.Y, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    static void Save(Bitmap bmp, string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        bmp.Save(path, ImageFormat.Png);
    }

    static void WriteIco(string icoPath, params string[] pngPaths)
    {
        var pngs = new List<byte[]>();
        foreach (var p in pngPaths) pngs.Add(File.ReadAllBytes(p));
        using (var fs = new FileStream(icoPath, FileMode.Create))
        using (var w = new BinaryWriter(fs))
        {
            w.Write((ushort)0); w.Write((ushort)1); w.Write((ushort)pngs.Count);
            int offset = 6 + pngs.Count * 16;
            for (int i = 0; i < pngs.Count; i++)
            {
                using (var img = Image.FromFile(pngPaths[i]))
                {
                    w.Write((byte)(img.Width >= 256 ? 0 : img.Width));
                    w.Write((byte)(img.Height >= 256 ? 0 : img.Height));
                }
                w.Write((byte)0); w.Write((byte)0);
                w.Write((ushort)1); w.Write((ushort)32);
                w.Write(pngs[i].Length);
                w.Write(offset);
                offset += pngs[i].Length;
            }
            foreach (var p in pngs) w.Write(p);
        }
    }

    static void Main(string[] args)
    {
        string outDir = args.Length > 0 ? args[0] : "icons";
        string fontFile = args.Length > 1 ? args[1] : null;
        string glyph = args.Length > 2 ? args[2] : "写";
        Directory.CreateDirectory(outDir);
        foreach (var size in new[] { 32, 64, 128, 256, 512 })
        {
            using (var bmp = Render(size, fontFile, glyph))
            {
                Save(bmp, Path.Combine(outDir, size + "x" + size + ".png"));
            }
        }
        using (var bmp = Render(256, fontFile, glyph)) Save(bmp, Path.Combine(outDir, "128x128@2x.png"));
        using (var bmp = Render(512, fontFile, glyph)) Save(bmp, Path.Combine(outDir, "icon.png"));
        WriteIco(Path.Combine(outDir, "icon.ico"),
            Path.Combine(outDir, "32x32.png"),
            Path.Combine(outDir, "64x64.png"),
            Path.Combine(outDir, "128x128.png"),
            Path.Combine(outDir, "256x256.png"));
        Console.WriteLine("icons written to " + Path.GetFullPath(outDir) + " glyph=" + glyph);
    }
}
