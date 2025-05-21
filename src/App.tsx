import React, { useState, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Grid, Text, Line, OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import {
  Box,
  Button,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  Typography,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  IconButton,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import * as THREE from 'three';
import { OrthographicCamera as ThreeOrthographicCamera, PerspectiveCamera as ThreePerspectiveCamera } from 'three';

// Type definitions for obstacle nodes and elements
type NodeType = { x: number; y: number; z: number };
type ElementType = { start: number; end: number };

const BOUNDING_BOX_WIDTH = 4; // meters
const BOUNDING_BOX_HEIGHT = 5; // meters

function BoundingBox() {
  // Draw a rectangle in the XY plane at z=0 (ground)
  // Points adjusted so bottom left is at origin (0,0,0)
  const basePoints = [
    [0, 0, 0], // bottom left
    [BOUNDING_BOX_WIDTH, 0, 0], // bottom right
    [BOUNDING_BOX_WIDTH, BOUNDING_BOX_HEIGHT, 0], // top right
    [0, BOUNDING_BOX_HEIGHT, 0], // top left
    [0, 0, 0], // back to bottom left
  ];

  // Create multiple parallel lines for thickness
  const lines = [];
  const thickness = 0.02; // 2cm thickness
  const numLines = 5; // Number of parallel lines

  for (let i = 0; i < numLines; i++) {
    const offset = (i - (numLines - 1) / 2) * thickness;
    const points = basePoints.map(([x, y, z]) => [x, y, z + offset]);
    lines.push(
      <line key={i}>
      <bufferGeometry>
      <bufferAttribute
        attach="attributes-position"
        args={[new Float32Array(points.flat()), 3]}
      />
      </bufferGeometry>
        <lineBasicMaterial color="orange" />
    </line>
  );
}

  return <>{lines}</>;
}

// --- Drone Animation ---
function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function getArcPoint(t: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, direction: 'clockwise' | 'anticlockwise', zOffset: number): [number, number, number] {
  // Elliptical arc in 3D as described in the screenshots
  // A = (sx, sy, sz), B = (x, y, z)
  // Major axis: AB
  // Minor axis: perpendicular to AB, length = |AB| / 2
  // Center: midpoint of AB
  // Parametric: center + (major/2)*cos(theta)*dir_AB + (minor/2)*sin(theta)*dir_perp
  // t in [0,1], theta = pi*(1-t)
  const ax = sx, ay = sy, az = sz;
  const bx = x, by = y, bz = z;
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const mz = (az + bz) / 2;
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const ab_len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (ab_len === 0) return [ax / 100, ay / 100, az / 100];
  // Major axis direction (normalized)
  const dir_AB = [dx / ab_len, dy / ab_len, dz / ab_len];
  // Find a vector perpendicular to AB for the minor axis
  // We'll use the cross product with the Z axis unless AB is vertical, then use X axis
  let perp: [number, number, number];
  if (Math.abs(dir_AB[0]) < 1e-6 && Math.abs(dir_AB[1]) < 1e-6) {
    // AB is vertical, use X axis
    perp = [0, 1, 0];
  } else {
    // Cross with Z axis
    perp = [-dir_AB[1], dir_AB[0], 0];
    const perp_len = Math.sqrt(perp[0] * perp[0] + perp[1] * perp[1] + perp[2] * perp[2]);
    perp = [perp[0] / perp_len, perp[1] / perp_len, perp[2] / perp_len];
  }
  // Flip minor axis for anticlockwise
  const minorSign = direction === 'anticlockwise' ? -1 : 1;
  // Major and minor axis lengths
  const a = ab_len / 2; // major
  const b = (ab_len / 4) * minorSign; // minor (AB = 2CD => b = a/2)
  // Parametric angle
  const theta = Math.PI * (1 - t);
  // Ellipse point
  const px = mx + a * Math.cos(theta) * dir_AB[0] + b * Math.sin(theta) * perp[0];
  const py = my + a * Math.cos(theta) * dir_AB[1] + b * Math.sin(theta) * perp[1];
  const pz = mz + a * Math.cos(theta) * dir_AB[2] + b * Math.sin(theta) * perp[2];
  return [px / 100, py / 100, pz / 100 + zOffset / 100];
}

function getLinePoint(t: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, zOffset: number): [number, number, number] {
  return [lerp(sx, x, t) / 100, lerp(sy, y, t) / 100, lerp(sz, z, t) / 100 + zOffset / 100];
}

function AnimatedDrone({
  mode,
  x,
  y,
  z,
  sx,
  sy,
  sz,
  speed,
  trigger,
  onDone,
  arcDirection,
  zOffset,
  onPathPoint,
}: {
  mode: 'arc' | 'flyto';
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  speed: number;
  trigger: number;
  onDone: () => void;
  arcDirection: 'clockwise' | 'anticlockwise';
  zOffset: number;
  onPathPoint?: (pos: [number, number, number]) => void;
}) {
  const meshRef = useRef<any>(null);
  const [t, setT] = useState(0);
  const [animating, setAnimating] = useState(false);
  const lastTrigger = useRef(trigger);

  React.useEffect(() => {
    if (trigger !== lastTrigger.current) {
      setT(0); // Reset to start
      setAnimating(true);
      lastTrigger.current = trigger;
    }
  }, [trigger]);

  useFrame((_, delta) => {
    if (!animating) return;
    // 100% speed = 1 m/s, but clamp duration to at least 1s for visibility
    const dist = Math.sqrt((x - sx) ** 2 + (y - sy) ** 2 + (z - sz) ** 2) / 100; // cm to m
    const duration = Math.max(1, dist / Math.max(0.1, speed / 100));
    setT(prev => {
      const nextT = prev + delta / duration;
      if (nextT >= 1) {
        setAnimating(false);
        onDone();
        if (onPathPoint) onPathPoint(pos); // Final point
        return 1;
      }
      return nextT;
    });
    if (onPathPoint) onPathPoint(pos);
  });

  let pos: [number, number, number] = [sx / 100, sy / 100, sz / 100];
  if (mode === 'arc') {
    pos = getArcPoint(t, x, y, z, sx, sy, sz, arcDirection, zOffset);
  } else {
    pos = getLinePoint(t, x, y, z, sx, sy, sz, zOffset);
  }

  return (
    <mesh ref={meshRef} position={pos}>
      <sphereGeometry args={[0.1, 32, 32]} />
      <meshStandardMaterial color="deepskyblue" />
    </mesh>
  );
}

const defaultNode = { x: 0, y: 0, z: 0 };
const defaultElement = { start: 0, end: 1 };

function ResetViewButton({ controlsRef }: { controlsRef: React.RefObject<any> }) {
  const { camera } = useThree();
  const handleClick = () => {
    camera.position.set(0, 0, 8);
    camera.lookAt(0, 0, 0);
    if (controlsRef.current) {
      controlsRef.current.target.set(0, 0, 0);
      controlsRef.current.update();
    }
  };
  return (
    <Button variant="outlined" fullWidth sx={{ mb: 2 }} onClick={handleClick}>
      Reset View
    </Button>
  );
}

// Helper: minimal distance from point to line segment in 3D
function pointToSegmentDistance(p: [number, number, number], a: [number, number, number], b: [number, number, number]) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const abLen2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  const dot = ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2];
  const t = abLen2 === 0 ? 0 : Math.max(0, Math.min(1, dot / abLen2));
  const closest = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
  const dx = p[0] - closest[0];
  const dy = p[1] - closest[1];
  const dz = p[2] - closest[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function App() {
  // Load from localStorage or use default
  const getLS = (key: string, def: any) => {
    const v = localStorage.getItem(key);
    try {
      return v !== null ? JSON.parse(v) : def;
    } catch {
      return def;
    }
  };

  // Flight path state
  const [mode, setMode] = useState<'arc' | 'flyto'>(() => getLS('mode', 'arc'));
  const [x, setX] = useState(() => getLS('endX', 0));
  const [y, setY] = useState(() => getLS('endY', 0));
  const [z, setZ] = useState(() => getLS('endZ', 0));
  const [speed, setSpeed] = useState(() => getLS('speed', 100));
  const [startX, setStartX] = useState(() => getLS('startX', 0));
  const [startY, setStartY] = useState(() => getLS('startY', 0));
  const [startZ, setStartZ] = useState(() => getLS('startZ', 0));
  const [zOffset, setZOffset] = useState(() => getLS('zOffset', 0));
  const [arcDirection, setArcDirection] = useState<'clockwise' | 'anticlockwise'>(() => getLS('arcDirection', 'clockwise'));
  const [endCoordMode, setEndCoordMode] = useState<'global' | 'local'>(() => getLS('endCoordMode', 'global'));
  const [nodes, setNodes] = useState<NodeType[]>(() => getLS('nodes', [{ x: 0, y: 0, z: 0 }]));
  const [elements, setElements] = useState<ElementType[]>(() => getLS('elements', [{ start: 0, end: 1 }]));

  // Save to localStorage on change
  React.useEffect(() => { localStorage.setItem('mode', JSON.stringify(mode)); }, [mode]);
  React.useEffect(() => { localStorage.setItem('endX', JSON.stringify(x)); }, [x]);
  React.useEffect(() => { localStorage.setItem('endY', JSON.stringify(y)); }, [y]);
  React.useEffect(() => { localStorage.setItem('endZ', JSON.stringify(z)); }, [z]);
  React.useEffect(() => { localStorage.setItem('speed', JSON.stringify(speed)); }, [speed]);
  React.useEffect(() => { localStorage.setItem('startX', JSON.stringify(startX)); }, [startX]);
  React.useEffect(() => { localStorage.setItem('startY', JSON.stringify(startY)); }, [startY]);
  React.useEffect(() => { localStorage.setItem('startZ', JSON.stringify(startZ)); }, [startZ]);
  React.useEffect(() => { localStorage.setItem('zOffset', JSON.stringify(zOffset)); }, [zOffset]);
  React.useEffect(() => { localStorage.setItem('arcDirection', JSON.stringify(arcDirection)); }, [arcDirection]);
  React.useEffect(() => { localStorage.setItem('endCoordMode', JSON.stringify(endCoordMode)); }, [endCoordMode]);
  React.useEffect(() => { localStorage.setItem('nodes', JSON.stringify(nodes)); }, [nodes]);
  React.useEffect(() => { localStorage.setItem('elements', JSON.stringify(elements)); }, [elements]);

  // Minimal clearance (placeholder)
  const [clearance, setClearance] = useState<number | null>(null);

  // Animation trigger
  const [simTrigger, setSimTrigger] = useState(0);

  // Animation done state
  const [animDone, setAnimDone] = useState(false);

  // Path tracking state
  const [path, setPath] = useState<[number, number, number][]>([]);

  // Live minimal clearance and collision
  const [liveClearance, setLiveClearance] = useState<number | null>(null);
  const [collision, setCollision] = useState(false);

  // Add state for top view trigger
  const [topViewTrigger, setTopViewTrigger] = useState(0);

  // Add state for top view projection
  const [topViewProjection, setTopViewProjection] = useState<'perspective' | 'orthographic'>('orthographic');

  // Add state for heading (degrees, CW)
  const [heading, setHeading] = useState(0);

  // Handlers for node/element table
  const handleNodeChange = (idx: number, key: 'x' | 'y' | 'z', value: number) => {
    setNodes((nodes: NodeType[]) => nodes.map((n: NodeType, i: number) => (i === idx ? { ...n, [key]: value } : n)));
  };
  const addNode = () => setNodes((nodes: NodeType[]) => [...nodes, { x: 0, y: 0, z: 0 }]);
  const removeNode = (idx: number) => setNodes((nodes: NodeType[]) => nodes.filter((_: NodeType, i: number) => i !== idx));

  const handleElementChange = (idx: number, key: 'start' | 'end', value: number) => {
    setElements((elements: ElementType[]) => elements.map((e: ElementType, i: number) => (i === idx ? { ...e, [key]: value } : e)));
  };
  const addElement = () => setElements((elements: ElementType[]) => [...elements, { start: 0, end: 1 }]);
  const removeElement = (idx: number) => setElements((elements: ElementType[]) => elements.filter((_: ElementType, i: number) => i !== idx));

  // Simulate button
  const handleSimulate = () => {
    setClearance(null); // Reset clearance
    setAnimDone(false);
    setPath([]); // Reset path
    setLiveClearance(null);
    setCollision(false);
    setSimTrigger(t => t + 1);
  };

  // Path point callback
  const handlePathPoint = (pos: [number, number, number]) => {
    setPath(prev => {
      if (prev.length === 0 || prev[prev.length - 1].some((v, i) => Math.abs(v - pos[i]) > 1e-5)) {
        return [...prev, pos];
      }
      return prev;
    });
    // Live minimal clearance calculation
    let minDist = Infinity;
    for (const el of elements) {
      const n1 = nodes[el.start];
      const n2 = nodes[el.end];
      if (!n1 || !n2) continue;
      const a: [number, number, number] = [n1.x / 100, n1.y / 100, n1.z / 100];
      const b: [number, number, number] = [n2.x / 100, n2.y / 100, n2.z / 100];
      const dist = pointToSegmentDistance(pos, a, b);
      if (dist < minDist) minDist = dist;
    }
    setLiveClearance(prev => (prev === null ? minDist : Math.min(prev, minDist)));
    if (minDist <= 0.1) setCollision(true);
  };

  // When animation completes, update clearance after a short delay
  React.useEffect(() => {
    if (animDone) {
      const timeout = setTimeout(() => {
        setClearance(Number(Math.random().toFixed(2))); // Placeholder
      }, 500);
      return () => clearTimeout(timeout);
    }
  }, [animDone]);

  const controlsRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);
  const orthoCamRef = useRef<ThreeOrthographicCamera>(null);
  const perspCamRef = useRef<ThreePerspectiveCamera>(null);

  const handleResetView = () => {
    try {
      if (cameraRef.current) {
        cameraRef.current.position.set(0, 0, 8);
        cameraRef.current.lookAt(0, 0, 0);
      }
      const controls = controlsRef.current?.controls || controlsRef.current;
      if (
        controls &&
        controls.target &&
        typeof controls.target.set === 'function' &&
        typeof controls.update === 'function'
      ) {
        controls.target.set(0, 0, 0);
        controls.update();
      } else {
        console.warn('OrbitControls not ready for reset', controls);
      }
    } catch (err) {
      console.error('Error resetting view:', err);
    }
  };

  // Top View button handler
  const handleTopView = () => {
    if (topViewProjection === 'orthographic' && orthoCamRef.current) {
      orthoCamRef.current.position.set(0, 0, 16);
      orthoCamRef.current.up.set(0, 1, 0);
      orthoCamRef.current.lookAt(0, 0, 0);
    } else if (topViewProjection === 'perspective' && perspCamRef.current) {
      perspCamRef.current.position.set(0, 0, 16);
      perspCamRef.current.up.set(0, 1, 0);
      perspCamRef.current.lookAt(0, 0, 0);
    }
    if (controlsRef.current) {
      controlsRef.current.target.set(0, 0, 0);
      controlsRef.current.update();
    }
  };

  return (
    <Box sx={{ 
      display: 'flex', 
      height: '100vh', 
      width: '100vw',
      flexDirection: { xs: 'column', md: 'row' } // Stack vertically on mobile, side-by-side on desktop
    }}>
      {/* Sidebar */}
      <Box sx={{ 
        width: { xs: '100%', md: 360 }, // Full width on mobile, fixed width on desktop
        height: { xs: 'auto', md: '100vh' }, // Auto height on mobile, full height on desktop
        p: 2, 
        bgcolor: '#f7f7fa', 
        boxShadow: 2, 
        zIndex: 2, 
        overflowY: 'auto',
        maxHeight: { xs: '50vh', md: '100vh' } // Limit height on mobile
      }}>
        <Typography variant="h5" gutterBottom>Drone Simulation</Typography>
        <Divider sx={{ mb: 2 }} />
        <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
          <Button variant="outlined" fullWidth onClick={handleTopView}>
            Top View
          </Button>
        </Box>
        <FormControl fullWidth sx={{ mb: 2 }}>
          <InputLabel>Top View Projection</InputLabel>
          <Select value={topViewProjection} label="Top View Projection" onChange={e => setTopViewProjection(e.target.value as any)}>
            <MenuItem value="perspective">Perspective</MenuItem>
            <MenuItem value="orthographic">Parallel (Orthographic)</MenuItem>
          </Select>
        </FormControl>
        {/* Mode Select */}
        <FormControl fullWidth sx={{ mb: 2 }}>
          <InputLabel>Mode</InputLabel>
          <Select value={mode} label="Mode" onChange={e => setMode(e.target.value as any)}>
            <MenuItem value="arc">Arc</MenuItem>
            <MenuItem value="flyto">Fly To</MenuItem>
          </Select>
        </FormControl>
        {/* Arc Direction Select */}
        {mode === 'arc' && (
          <FormControl fullWidth sx={{ mb: 2 }}>
            <InputLabel>Arc Direction</InputLabel>
            <Select value={arcDirection} label="Arc Direction" onChange={e => setArcDirection(e.target.value as any)}>
              <MenuItem value="clockwise">Clockwise</MenuItem>
              <MenuItem value="anticlockwise">Anticlockwise</MenuItem>
            </Select>
          </FormControl>
        )}
        {/* Start Coordinate Input */}
        <Typography variant="subtitle1">Start Coordinate</Typography>
        <TextField 
          label="Start X (cm)" 
          value={startX} 
          onChange={e => setStartX(Number(e.target.value))} 
          fullWidth 
          sx={{ mb: 1 }} 
        />
        <TextField 
          label="Start Y (cm)" 
          value={startY} 
          onChange={e => setStartY(Number(e.target.value))} 
          fullWidth 
          sx={{ mb: 1 }} 
        />
        <TextField 
          label="Start Z (cm)" 
          value={startZ} 
          onChange={e => setStartZ(Number(e.target.value))} 
          fullWidth 
          sx={{ mb: 2 }} 
        />
        {/* End Coordinate Input */}
        <Typography variant="subtitle1">End Coordinate</Typography>
        <FormControl fullWidth sx={{ mb: 2 }}>
          <InputLabel>End Coord Mode</InputLabel>
          <Select value={endCoordMode} label="End Coord Mode" onChange={e => setEndCoordMode(e.target.value as any)}>
            <MenuItem value="global">Global</MenuItem>
            <MenuItem value="local">Local (relative to start)</MenuItem>
          </Select>
        </FormControl>
        {endCoordMode === 'local' && (
          <TextField
            label="Heading (deg, CW)"
            type="number"
            value={heading}
            onChange={e => setHeading(Number(e.target.value))}
            fullWidth
            sx={{ mb: 2 }}
          />
        )}
        <Box sx={{ display: 'flex', gap: 1, mb: 2 }}>
          <TextField
            label={endCoordMode === 'global' ? "End X (cm)" : "End X (cm, offset)"}
            value={x}
            onChange={e => setX(Number(e.target.value))}
            fullWidth
            sx={{ flex: 1 }}
          />
          <TextField
            label={endCoordMode === 'global' ? "End Y (cm)" : "End Y (cm, offset)"}
            value={y}
            onChange={e => setY(Number(e.target.value))}
            fullWidth
            sx={{ flex: 1 }}
          />
          <TextField
            label={endCoordMode === 'global' ? "End Z (cm)" : "End Z (cm, offset)"}
            value={z}
            onChange={e => setZ(Number(e.target.value))}
            fullWidth
            sx={{ flex: 1 }}
          />
        </Box>
        <TextField label="Speed (%)" type="number" value={speed} onChange={e => setSpeed(Number(e.target.value))} fullWidth sx={{ mb: 2 }} />
        {/* Z Offset Input */}
        <TextField label="Z Offset (cm)" type="number" value={zOffset} onChange={e => setZOffset(Number(e.target.value))} fullWidth sx={{ mb: 2 }} />
        <Divider sx={{ my: 2 }} />
        {/* Obstacle Nodes Table */}
        <Typography variant="subtitle1">Obstacle Nodes</Typography>
        <TableContainer component={Paper} sx={{ mb: 1 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>#</TableCell>
                <TableCell>X</TableCell>
                <TableCell>Y</TableCell>
                <TableCell>Z</TableCell>
                <TableCell></TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {nodes.map((node: NodeType, idx: number) => (
                <TableRow key={idx}>
                  <TableCell>{idx}</TableCell>
                  <TableCell><TextField value={node.x} onChange={e => handleNodeChange(idx, 'x', Number(e.target.value))} size="small" type="number" inputProps={{ step: 'any' }} sx={{ width: 70 }} /></TableCell>
                  <TableCell><TextField value={node.y} onChange={e => handleNodeChange(idx, 'y', Number(e.target.value))} size="small" type="number" inputProps={{ step: 'any' }} sx={{ width: 70 }} /></TableCell>
                  <TableCell><TextField value={node.z} onChange={e => handleNodeChange(idx, 'z', Number(e.target.value))} size="small" type="number" inputProps={{ step: 'any' }} sx={{ width: 70 }} /></TableCell>
                  <TableCell><IconButton onClick={() => removeNode(idx)} size="small"><DeleteIcon fontSize="small" /></IconButton></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        <Button onClick={addNode} size="small" sx={{ mb: 2 }}>Add Node</Button>
        {/* Obstacle Elements Table */}
        <Typography variant="subtitle1">Obstacle Elements</Typography>
        <TableContainer component={Paper} sx={{ mb: 1 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Start Node</TableCell>
                <TableCell>End Node</TableCell>
                <TableCell></TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {elements.map((el: ElementType, idx: number) => (
                <TableRow key={idx}>
                  <TableCell><TextField value={el.start} onChange={e => handleElementChange(idx, 'start', Number(e.target.value))} size="small" type="number" /></TableCell>
                  <TableCell><TextField value={el.end} onChange={e => handleElementChange(idx, 'end', Number(e.target.value))} size="small" type="number" /></TableCell>
                  <TableCell><IconButton onClick={() => removeElement(idx)} size="small"><DeleteIcon fontSize="small" /></IconButton></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        <Button onClick={addElement} size="small" sx={{ mb: 2 }}>Add Element</Button>
        <Divider sx={{ my: 2 }} />
        {/* Simulate button moved to 3D scene area */}
        <Typography variant="body1">
          Minimal Clearance: {liveClearance !== null ? `${liveClearance.toFixed(3)} m` : '--'}
          {collision && <span style={{ color: 'red', marginLeft: 8 }}>(Collision!)</span>}
        </Typography>
      </Box>
      {/* 3D Scene */}
      <Box sx={{ 
        flex: 1, 
        position: 'relative',
        height: { xs: '50vh', md: '100vh' } // Half height on mobile, full height on desktop
      }}>
        <Button 
          variant="contained" 
          color="primary" 
          sx={{ 
            position: 'absolute',
            bottom: 24,
            right: 24,
            zIndex: 1000,
            minWidth: 140,
            minHeight: 48,
            boxShadow: 3
          }} 
          onClick={handleSimulate}
        >
          Simulate
        </Button>
        <Canvas camera={{ position: [0, 0, 16], fov: 50 }} ref={cameraRef} shadows>
          {topViewProjection === 'orthographic' ? (
            <OrthographicCamera
              ref={orthoCamRef}
              makeDefault
              position={[0, 0, 16]}
              zoom={50}
              near={0.1}
              far={100}
              up={[0, 1, 0]}
            />
          ) : (
            <PerspectiveCamera
              ref={perspCamRef}
              makeDefault
              position={[0, 0, 16]}
              fov={50}
              near={0.1}
              far={100}
              up={[0, 1, 0]}
            />
          )}
          <ambientLight intensity={0.7} />
          <directionalLight position={[5, 5, 10]} intensity={0.7} />
          {/* 1m grid, 10x10 size */}
          <Grid
            args={[10, 10]}
            cellSize={1}
            cellThickness={0.5}
            sectionSize={5}
            sectionThickness={1.5}
            sectionColor={'#444'}
            cellColor={'#888'}
            fadeDistance={30}
            fadeStrength={1}
            infiniteGrid={false}
              rotation={[Math.PI / 2, 0, 0]}
          />
          <BoundingBox />
          {/* Axis Labels */}
          <Text position={[5.2, 0, 0]} fontSize={0.3} color="red" anchorX="left" anchorY="middle">X</Text>
          <Text position={[0, 5.2, 0]} fontSize={0.3} color="green" anchorX="left" anchorY="middle">Y</Text>
          <Text position={[0, 0, 2.2]} fontSize={0.3} color="blue" anchorX="left" anchorY="middle">Z</Text>
          {/* Flight Path Tracking Line */}
          {path.length > 1 && (
            <Line points={path} color={collision ? "red" : "orange"} lineWidth={3} />
          )}
          {/* Obstacle Lines */}
          {elements.map((el: ElementType, idx: number) => {
            const n1 = nodes[el.start];
            const n2 = nodes[el.end];
            if (!n1 || !n2) return null;
            return (
              <Line
                key={idx}
                points={[
                  [n1.x / 100, n1.y / 100, n1.z / 100],
                  [n2.x / 100, n2.y / 100, n2.z / 100],
                ]}
                color="#7c3aed" // purple
                lineWidth={2}
              />
            );
          })}
          <AnimatedDrone
            mode={mode}
            x={endCoordMode === 'global' ? x : startX + (x * Math.cos((heading * Math.PI) / 180) + y * Math.sin((heading * Math.PI) / 180))}
            y={endCoordMode === 'global' ? y : startY + (-x * Math.sin((heading * Math.PI) / 180) + y * Math.cos((heading * Math.PI) / 180))}
            z={endCoordMode === 'global' ? z : startZ + z}
            sx={startX}
            sy={startY}
            sz={startZ}
            speed={speed}
            trigger={simTrigger}
            onDone={() => setAnimDone(true)}
            arcDirection={arcDirection}
            zOffset={zOffset}
            onPathPoint={handlePathPoint}
          />
          <OrbitControls ref={controlsRef} target={[0, 0, 0]} maxPolarAngle={Math.PI - 0.1} minPolarAngle={0.1} enablePan={true} />
          {/* Visualize heading in local mode */}
          {endCoordMode === 'local' && (() => {
            const len = 0.5; // 0.5 meters
            const rad = (heading * Math.PI) / 180;
            const from: [number, number, number] = [startX / 100, startY / 100, startZ / 100];
            const to: [number, number, number] = [
              from[0] + Math.sin(rad) * len,
              from[1] + Math.cos(rad) * len,
              from[2],
            ];
            const conePos: [number, number, number] = [to[0], to[1], to[2]];
            const coneRot: [number, number, number] = [0, 0, -rad];
            return (
              <>
                <Line points={[from, to]} color="#00bcd4" lineWidth={2} />
                <mesh position={conePos} rotation={coneRot}>
                  <coneGeometry args={[0.08, 0.24, 16]} />
                  <meshStandardMaterial color="#00bcd4" />
                </mesh>
              </>
            );
          })()}
        </Canvas>
      </Box>
    </Box>
  );
}

export default App; 