import { useEffect, useRef } from "react";
import * as THREE from "three";

export function TransferScene({ step, progress }) {
  const mountRef = useRef(null);

  useEffect(() => {
    if (!mountRef.current) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.z = 5;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.domElement.className = 'three-canvas';
    mountRef.current.appendChild(renderer.domElement);

    const particles = new THREE.BufferGeometry();
    const particleCount = 2000;
    const posArray = new Float32Array(particleCount * 3);
    for (let i = 0; i < particleCount * 3; i++) {
        posArray[i] = (Math.random() - 0.5) * 20;
    }
    particles.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
    
    const material = new THREE.PointsMaterial({
        size: 0.04,
      color: 0xffffff,
        transparent: true,
      opacity: 0.35,
        blending: THREE.AdditiveBlending
    });
    const particleMesh = new THREE.Points(particles, material);
    scene.add(particleMesh);

    let frameId;
    
    const onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', onResize);

    const render = () => {
      frameId = window.requestAnimationFrame(render);
      particleMesh.rotation.y += 0.0003 + (progress * 0.002);

      if (step === 'transferring') {
          camera.position.z = THREE.MathUtils.lerp(camera.position.z, 2.5 - (progress * 1.5), 0.02);
          material.color.lerp(new THREE.Color(0xd6d6d6), 0.05);
          
          const positions = particleMesh.geometry.attributes.position.array;
          for(let i = 2; i < particleCount * 3; i+=3) {
             positions[i] += 0.02 + (progress * 0.2);
             if (positions[i] > 5) positions[i] = -15;
          }
          particleMesh.geometry.attributes.position.needsUpdate = true;
      } else if (step === 'done') {
          camera.position.z = THREE.MathUtils.lerp(camera.position.z, 6, 0.05);
            material.color.lerp(new THREE.Color(0xffffff), 0.05);
      } else {
          camera.position.z = THREE.MathUtils.lerp(camera.position.z, 5, 0.05);
            material.color.lerp(new THREE.Color(0x9a9a9a), 0.05);
      }

      renderer.render(scene, camera);
    };

    frameId = window.requestAnimationFrame(render);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('resize', onResize);
      particles.dispose();
      material.dispose();
      renderer.dispose();
      if (mountRef.current?.contains(renderer.domElement)) {
        mountRef.current.removeChild(renderer.domElement);
      }
    };
  }, [step, progress]);

  return <div ref={mountRef} aria-hidden="true" className="scene-background" />;
}