/**
 * 参数曲面是唯一的轨迹定义：宽带、细丝、粒子复用它，避免各层绕不同轴旋转。
 * 只使用周期函数，首尾闭合；时间仅做有界形变，主体不会翻转或逐渐漂出画布。
 */
const flowSurface = `
  uniform float uTime;
  uniform float uEnergy;
  attribute float aSeed;
  const float TAU = 6.28318530718;

  vec3 flowPoint(float angle, float lane, float seed, float core) {
    float breath = sin(uTime * 0.55) * 0.012 * uEnergy;
    if (core > 0.5) {
      float radius = 0.64 + lane * 0.17;
      radius += sin(angle * 3.0 + lane * 5.0 - uTime * 0.38) * 0.025;
      radius += sin(angle * 5.0 - lane * 3.0 + seed) * 0.012;
      return vec3(
        cos(angle) * radius * (0.94 + breath),
        sin(angle) * radius * 1.12,
        sin(angle * 2.0 + lane * 3.0 + seed) * 0.095 + lane * 0.23
      );
    }
    float ripple = sin(angle * 3.0 + seed + uTime * 0.24) * 0.035;
    float radius = 1.0 + lane * 0.18 + ripple + breath;
    float twist = angle * 2.0 + seed * 0.3 + sin(uTime * 0.23) * 0.1;
    vec3 point = vec3(
      cos(angle) * 1.65 * radius,
      sin(angle) * 0.69 * radius + lane * cos(twist) * 0.66,
      sin(angle) * 0.52 + lane * sin(twist) * 0.8
    );
    point.y += sin(angle * 2.0 + seed * 0.4) * 0.16;
    float tilt = -0.25 + seed * 0.067;
    point.xy = mat2(cos(tilt), -sin(tilt), sin(tilt), cos(tilt)) * point.xy;
    return point;
  }
`;

// 珠白基底 + 局部薄膜色散。暖金和淡紫只出现在反射区，避免整个表面变成彩虹。
const spectralColor = `
  vec3 spectral(float phase) {
    vec3 ice = vec3(0.24, 0.79, 1.0);
    vec3 rose = vec3(0.86, 0.46, 0.77);
    vec3 gold = vec3(1.0, 0.76, 0.37);
    vec3 color = mix(ice, rose, smoothstep(-0.3, 0.7, sin(phase)));
    return mix(color, gold, pow(max(0.0, cos(phase + 1.5)), 6.0));
  }
`;

export const ribbonVertexShader = `
  ${flowSurface}
  varying vec2 vUv;
  varying vec3 vView;
  varying float vSeed;
  varying float vCore;
  void main() {
    vUv = uv;
    vSeed = aSeed;
    vCore = position.z;
    vec3 point = flowPoint(position.x * TAU, position.y, aSeed, position.z);
    vec4 view = modelViewMatrix * vec4(point, 1.0);
    vView = view.xyz;
    gl_Position = projectionMatrix * view;
  }
`;

export const ribbonFragmentShader = `
  uniform float uTime;
  uniform float uEnergy;
  uniform float uOpacity;
  uniform float uFine;
  varying vec2 vUv;
  varying vec3 vView;
  varying float vSeed;
  varying float vCore;
  ${spectralColor}
  void main() {
    // 从形变后的曲面求法线，反射高光随真实折叠变化，而不是贴上固定亮边。
    vec3 normal = normalize(cross(dFdx(vView), dFdy(vView)));
    float facing = abs(dot(normal, normalize(-vView)));
    float fresnel = pow(1.0 - facing, 2.2);
    float edgeDistance = min(vUv.y, 1.0 - vUv.y);
    float edge = exp(-edgeDistance * 86.0);
    float angle = vUv.x * 6.2831853;
    float traveling = pow(0.5 + 0.5 * sin(angle * 3.0 - uTime * 0.62 + vSeed), 12.0);
    float silk = pow(0.5 + 0.5 * sin(vUv.y * 116.0 + sin(angle * 3.0) * 5.0 - uTime * 0.3), 18.0);
    vec3 tint = spectral(angle * 2.0 + vSeed * 0.4 + fresnel * 2.2 + vUv.y * 1.2);
    vec3 pearl = vec3(0.87, 0.96, 1.0);
    vec3 color = mix(tint, pearl, 0.25 + edge * 0.45);
    float reflection = pow(0.5 + 0.5 * sin(angle * 2.0 + vUv.y * 2.5 - uTime * 0.16), 18.0);
    float body = 0.055 + fresnel * 0.22 + silk * 0.06;
    float light = edge * (0.68 + traveling * 1.25) + reflection * 0.25 + traveling * fresnel * 0.4;
    float alpha = (body + light) * uOpacity;
    alpha *= mix(0.75, 1.1, vCore) * (0.8 + uEnergy * 0.2);
    if (uFine > 0.5) {
      alpha = (0.14 + traveling * 0.55) * uOpacity;
      color = mix(tint, pearl, 0.48);
    }
    gl_FragColor = vec4(color * (1.0 + light * 0.65), alpha);
  }
`;

export const particleVertexShader = `
  ${flowSurface}
  uniform float uDpr;
  attribute float aSize;
  varying float vAlpha;
  varying float vTint;
  void main() {
    // 粒子沿曲面参数前进，不旋转整团点云；各流速接近，保持可读的方向感。
    float speed = mix(0.022, 0.038, position.z);
    float angle = (position.x + uTime * speed) * TAU;
    vec3 point = flowPoint(angle, position.y, aSeed, position.z);
    point.z += sin(position.x * 671.0 + aSeed) * 0.045;
    vec4 view = modelViewMatrix * vec4(point, 1.0);
    gl_Position = projectionMatrix * view;
    gl_PointSize = clamp(aSize * uDpr * 6.0 / -view.z, 0.7, 5.0);
    vAlpha = (0.3 + 0.65 * pow(0.5 + 0.5 * sin(angle * 2.0 - uTime * 0.4 + aSeed), 3.0));
    vAlpha *= mix(0.6, 1.0, smoothstep(-0.7, 0.65, point.z));
    vTint = angle + aSeed * 0.4;
  }
`;

export const particleFragmentShader = `
  varying float vAlpha;
  varying float vTint;
  ${spectralColor}
  void main() {
    float radius = length(gl_PointCoord - 0.5);
    float light = 1.0 - smoothstep(0.05, 0.5, radius);
    vec3 color = mix(spectral(vTint), vec3(0.92, 0.98, 1.0), 0.6);
    gl_FragColor = vec4(color, light * vAlpha * 0.83);
  }
`;

export const coreVertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const coreFragmentShader = `
  uniform float uTime;
  uniform float uEnergy;
  varying vec2 vUv;
  ${spectralColor}
  void main() {
    vec2 p = (vUv - 0.5) * 2.05;
    p.y /= 1.12;
    float radius = length(p);
    float angle = atan(p.y, p.x);
    float ringRadius = 0.64 + sin(angle * 3.0 - uTime * 0.38) * 0.016;
    float rim = exp(-pow((radius - ringRadius) * 49.0, 2.0));
    float halo = exp(-pow((radius - ringRadius) * 10.5, 2.0));
    float heart = exp(-radius * radius * 15.0);
    float well = exp(-radius * radius * 6.0);
    float gleam = pow(0.5 + 0.5 * sin(angle * 2.0 - uTime * 0.22), 6.0);
    vec3 tint = spectral(angle + uTime * 0.03);
    vec3 color = mix(tint, vec3(0.9, 0.98, 1.0), 0.72);
    float alpha = rim * (0.38 + gleam * 0.36) + halo * 0.25 + heart * 0.62 + well * 0.05;
    gl_FragColor = vec4(color, alpha * (0.85 + uEnergy * 0.15));
  }
`;
